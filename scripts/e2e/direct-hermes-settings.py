#!/usr/bin/env python3
"""Real HTTP/settings + opaque proxy access acceptance on Stack's own fixtures.

No API auth bypass, synthetic RPC frames, production users, or second Hermes.
Token rotation uses a deliberately invalid replacement, proves rejection by the
real upstream, then restores the original valid token before browser acceptance.
"""
import asyncio
import json
import secrets
import time
import uuid

import websockets

PUBLIC_KEYS = {'botId', 'endpoint', 'gatewayTokenConfigured', 'allowedUserIds', 'eligibleUsers', 'revision'}
REVOKE_BOUND_SECONDS = 5


def cipher(stack):
    bot_id = str(uuid.UUID(stack.bot['id']))
    value = stack.run(stack.docker + ['exec', stack.containers[0], 'psql', '-U', 'thechat', '-d', 'thechat', '-Atc',
        f"select gateway_token_encrypted from hermes_rpc_bot_configs where bot_id='{bot_id}';"]).strip()
    if not hasattr(stack, 'gateway_ciphertexts'):
        stack.gateway_ciphertexts = set()
    stack.gateway_ciphertexts.add(value)
    return value


def public_settings(stack, value, headers):
    assert headers.get('cache-control') == 'no-store', headers
    assert isinstance(value, dict) and set(value) == PUBLIC_KEYS, list(value) if isinstance(value, dict) else type(value)
    assert value['botId'] == stack.bot['id'] and value['gatewayTokenConfigured'] is True
    assert isinstance(value['revision'], str) and value['revision']
    assert isinstance(value['allowedUserIds'], list) and len(set(value['allowedUserIds'])) == len(value['allowedUserIds'])
    assert all(set(user) == {'id', 'name'} for user in value['eligibleUsers'])
    serialized = json.dumps(value)
    for secret in [stack.gateway_token, *getattr(stack, 'replacement_tokens', []), cipher(stack)]:
        assert secret and secret not in serialized, 'Settings response disclosed a gateway credential/ciphertext'
    return value


def get_settings(stack):
    return public_settings(stack, *stack.api_ok('GET', settings_path(stack), token=stack.owner_token))


def settings_path(stack):
    return f"/bots/{stack.bot['id']}/hermes-rpc/settings"


def patch_settings(stack, settings, **changes):
    result = public_settings(stack, *stack.api_ok('PATCH', settings_path(stack),
        {'revision': settings['revision'], **changes}, stack.owner_token))
    # A successful write is not enough: round-trip exact public metadata.
    assert get_settings(stack) == result, 'PATCH settings did not round-trip'
    return result


def ticket_for(stack, persona, expected=200, conversation=None):
    result, headers = stack.api_ok('POST', f"/bots/{stack.bot['id']}/hermes-rpc/proxy-ticket",
        {'conversationId': (conversation or persona['conversation'])['id']}, persona['accessToken'], expected=expected)
    assert headers.get('cache-control') == 'no-store'
    assert stack.gateway_token not in json.dumps(result)
    assert cipher(stack) not in json.dumps(result), 'Ticket response disclosed encrypted gateway credential'
    return result


def join(stack, persona):
    invitation, _ = stack.api_ok('POST', '/invites/create',
        {'workspaceId': stack.workspace['id'], 'email': persona['user']['email']}, stack.owner_token)
    stack.api_ok('POST', '/invites/accept', {'inviteId': invitation['id']}, persona['accessToken'])


def seed_people(stack):
    stack.people = {}
    for role in ('grantee', 'denied', 'former-member'):
        name = 'Direct Hermes Fixture ' + role.title()
        persona, _ = stack.api_ok('POST', '/auth/register', {'name': name,
            'email': stack.run_id + '-' + role + '@example.test', 'password': 'Disposable-direct-hermes-123!'})
        join(stack, persona)
        persona['conversation'], _ = stack.api_ok('POST', '/conversations/dm',
            {'workspaceId': stack.workspace['id'], 'otherUserId': stack.bot['userId']}, persona['accessToken'])
        stack.people[role] = persona
    stack.people['outsider'] = stack.outsider


async def rejected_ticket(ticket, protocol):
    try:
        async with websockets.connect(ticket['proxyUrl'],
                subprotocols=[protocol, 'thechat-ticket.' + ticket['ticket']], open_timeout=5):
            raise AssertionError('Revoked unconsumed ticket was accepted')
    except websockets.exceptions.InvalidStatus as error:
        assert error.response.status_code == 401, error.response.status_code


async def closed_promptly(rpc, started):
    await asyncio.wait_for(rpc.ws.wait_closed(), timeout=REVOKE_BOUND_SECONDS)
    elapsed = time.monotonic() - started
    assert elapsed <= REVOKE_BOUND_SECONDS, elapsed
    return {'elapsedSeconds': elapsed, 'closeCode': rpc.ws.close_code, 'boundSeconds': REVOKE_BOUND_SECONDS}


async def verify(stack, RPC, protocol, fixture):
    # First tracer bullet intentionally fails on the old owner-only API (404).
    initial = get_settings(stack)
    assert initial['allowedUserIds'] == [], 'New bots must default to owner-only'
    seed_people(stack)
    current = get_settings(stack)
    grantee, denied, outsider = (stack.people[key] for key in ('grantee', 'denied', 'outsider'))
    grantee_id = grantee['user']['id']
    eligible = {user['id'] for user in current['eligibleUsers']}
    assert {grantee_id, denied['user']['id']} <= eligible
    assert outsider['user']['id'] not in eligible and stack.bot['userId'] not in eligible
    path = settings_path(stack)
    for persona in (grantee, denied, stack.people['former-member'], outsider):
        for method, body in (('GET', None), ('PATCH', {'revision': current['revision'], 'allowedUserIds': []})):
            body, headers = stack.api_ok(method, path, body, persona['accessToken'], expected=403)
            assert headers.get('cache-control') == 'no-store'
            assert stack.gateway_token not in json.dumps(body) and cipher(stack) not in json.dumps(body)
    for persona in (grantee, denied):
        ticket_for(stack, persona, expected=403)
    ticket_for(stack, outsider, expected=403, conversation=stack.conversation)
    checks = stack.report.setdefault('settings', {'checks': {}})['checks']
    checks.update(defaultOwnerOnly=True, currentWorkspaceHumansEligible=True, outsiderAndBotIneligible=True,
        nonOwnerSettingsGetPatchForbidden403=True, unselectedHumanTicketForbidden403=True)

    # Validation must be atomic: none of these errors may alter revision/config.
    invalid = [
        {'endpoint': 'file:///tmp/hermes'}, {'endpoint': stack.upstream + '?token=not-a-real-secret'},
        {'endpoint': stack.upstream.replace('://', '://user:password@')},
        {'endpoint': stack.upstream + '/changed'},
        {'endpoint': stack.upstream + '/changed', 'gatewayToken': '  '},
        {'allowedUserIds': [grantee_id]},
        {'allowedUserIds': [outsider['user']['id']], 'acknowledgeSharedAccess': True},
        {'allowedUserIds': [stack.bot['userId']], 'acknowledgeSharedAccess': True},
    ]
    for changes in invalid:
        _, headers = stack.api_ok('PATCH', path, {'revision': current['revision'], **changes}, stack.owner_token, expected=400)
        assert headers.get('cache-control') == 'no-store'
        assert get_settings(stack) == current, 'Invalid PATCH mutated settings'
    original_cipher = cipher(stack)
    assert original_cipher and stack.gateway_token not in original_cipher
    current = patch_settings(stack, current, endpoint=current['endpoint'], gatewayToken='')
    assert cipher(stack) == original_cipher, 'Blank token replaced the existing encrypted token'
    current = patch_settings(stack, current, allowedUserIds=[grantee_id], acknowledgeSharedAccess=True)
    assert current['allowedUserIds'] == [grantee_id]
    assert cipher(stack) == original_cipher, 'Omitted token changed the existing encrypted credential'
    _, headers = stack.api_ok('PATCH', path, {'revision': initial['revision'], 'allowedUserIds': []}, stack.owner_token, expected=409)
    assert headers.get('cache-control') == 'no-store' and get_settings(stack) == current
    # A grant does not make someone an owner, or authorize another human's DM.
    stack.api_ok('GET', path, token=grantee['accessToken'], expected=403)
    stack.api_ok('PATCH', path, {'revision': current['revision'], 'allowedUserIds': []}, grantee['accessToken'], expected=403)
    ticket_for(stack, grantee, expected=403, conversation=stack.conversation)
    ticket_for(stack, denied, expected=403)
    checks.update(invalidSettingsAtomic=True, newGrantRequiresAcknowledgment=True, blankTokenKept=True,
        staleRevisionRejected409=True, grantDoesNotExposeSettings=True, ownDmStillRequired=True, encryptedAtRest=True)

    async with RPC(stack, ticket_for(stack, grantee)) as rpc:
        listed = await rpc.call('session.list', {'limit': 200})
        assert stack.report['sessionIds']['a'] in {session['id'] for session in listed['sessions']}
        resumed = await rpc.call('session.resume', {'session_id': stack.report['sessionIds']['a']})
        assert fixture.FINAL_A in json.dumps(resumed), 'Authorized people intentionally share the SAME Hermes gateway history'
        await rpc.turn(resumed['session_id'], 'DIRECT_HERMES_FOLLOWUP_A', fixture.FINAL_FOLLOWUP)
        stale_grantee, stale_owner = ticket_for(stack, grantee), stack.ticket()
        started = time.monotonic()
        current = patch_settings(stack, current, allowedUserIds=[])
        stack.report['settings']['grantRevocation'] = await closed_promptly(rpc, started)
    await rejected_ticket(stale_grantee, protocol)
    await rejected_ticket(stale_owner, protocol)
    ticket_for(stack, grantee, expected=403)
    checks.update(granteeGatewayReadyListPrompt=True, intentionallySharedHistory=True,
        revokeClosesActiveTunnel=True, revokeInvalidatesUnconsumedTickets=True, revokedFreshTicketForbidden403=True)

    # Use a separate fixture person for removal. Rejoining an already-accepted
    # invite hits an unrelated existing invite uniqueness issue; no DB/auth bypass.
    former = stack.people['former-member']
    former_id = former['user']['id']
    current = patch_settings(stack, current, allowedUserIds=[former_id], acknowledgeSharedAccess=True)
    stack.api_ok('DELETE', f"/workspaces/{stack.workspace['id']}/members/{former_id}", token=stack.owner_token)
    ticket_for(stack, former, expected=403)
    checks['membershipStillRequired'] = True
    current = patch_settings(stack, get_settings(stack), allowedUserIds=[])

    invalid_token = secrets.token_urlsafe(32)
    stack.replacement_tokens = [invalid_token]
    async with RPC(stack, stack.ticket()) as rpc:
        stale = stack.ticket()
        started = time.monotonic()
        current = patch_settings(stack, current, gatewayToken=invalid_token)
        stack.report['settings']['tokenRotation'] = await closed_promptly(rpc, started)
    assert cipher(stack) != original_cipher and invalid_token not in cipher(stack)
    await rejected_ticket(stale, protocol)
    invalid_ticket = stack.ticket()
    upstream_rejected = False
    try:
        async with websockets.connect(invalid_ticket['proxyUrl'],
                subprotocols=[protocol, 'thechat-ticket.' + invalid_ticket['ticket']], open_timeout=5) as ws:
            async with asyncio.timeout(10):
                async for frame in ws:
                    assert 'gateway.ready' not in frame, 'Invalid replacement token authenticated to real Hermes'
            upstream_rejected = ws.close_code not in (None, 1000)
    except websockets.exceptions.InvalidStatus as error:
        upstream_rejected = error.response.status_code in (401, 502)
    except websockets.exceptions.ConnectionClosedError as error:
        upstream_rejected = error.rcvd is not None and error.rcvd.code in (1008, 1011, 1013)
    assert upstream_rejected, 'Invalid token not rejected by real upstream'
    current = patch_settings(stack, current, gatewayToken=stack.gateway_token)
    # Endpoint changes require a replacement even though this path is not served.
    changed = patch_settings(stack, current, endpoint=stack.upstream + '/replacement', gatewayToken=stack.gateway_token)
    assert changed['endpoint'].endswith('/replacement/api/ws')
    current = patch_settings(stack, changed, endpoint=stack.upstream, gatewayToken=stack.gateway_token)
    async with RPC(stack, stack.ticket()) as rpc:
        listed = await rpc.call('session.list', {'limit': 200})
        assert stack.report['sessionIds']['a'] in {session['id'] for session in listed['sessions']}
    checks.update(tokenRotationRevokesActiveAndUnusedTickets=True, invalidReplacementRejectedByRealUpstream=True,
        restoredTokenOpaqueRelayWorks=True, endpointReplacementRequiresNewToken=True, ownerMetadataRoundTrips=True,
        settingsNoStoreAndCredentialRedaction=True)
    assert current['allowedUserIds'] == []
    stack.report['settings']['status'] = 'PASS'
    stack.report['settings']['scope'] = 'Real HTTP/API/Redis/PG/proxy/Hermes; disposable fixture people only. Shared gateway/sessions intentionally NOT private per-person chats.'
    (stack.root / 'settings-evidence.json').write_text(json.dumps(stack.report['settings'], indent=2))
