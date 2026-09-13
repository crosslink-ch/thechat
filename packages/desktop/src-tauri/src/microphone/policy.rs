//! Session-only consent and single-use recording authorization; no OS permission changes.
use std::time::{Duration, Instant};
use url::Url;

pub const INTENT_TTL: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Trust(pub Url);
impl Trust {
    pub fn matches(&self, uri: &str) -> bool {
        Url::parse(uri).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
                && url.origin() == self.0.origin()
        })
    }
}

#[derive(Default)]
pub struct Session {
    pub ready: bool,
    pub consent: bool,
    pub generation: u64,
    intent: Option<Instant>,
}

#[derive(Clone)]
pub struct Request<'a> {
    pub window: &'a str,
    pub source: &'a str,
    pub uri: &'a str,
    pub microphone_only: bool,
    pub top_frame: bool,
    pub user_initiated: bool,
    pub saved_denied: bool,
    pub generation: u64,
}

impl Session {
    pub fn can_prepare(
        &self,
        trust: &Trust,
        source: &str,
        window: &str,
        generation: u64,
        saved_denied: bool,
    ) -> bool {
        self.ready
            && !saved_denied
            && self.generation == generation
            && window == "main"
            && trust.matches(source)
    }
    pub fn authorize(&mut self, trust: &Trust, request: &Request<'_>, now: Instant) -> bool {
        if request.generation != self.generation {
            return false;
        }
        let live_intent = self.consume(now);
        live_intent
            && self.consent
            && self.can_prepare(
                trust,
                request.source,
                request.window,
                request.generation,
                request.saved_denied,
            )
            && trust.matches(request.uri)
            && request.microphone_only
            && request.top_frame
            && request.user_initiated
    }
    pub fn invalidate(&mut self) {
        self.intent = None;
        self.generation = self.generation.wrapping_add(1);
    }
    pub fn complete_prepare(&mut self, started: Instant, now: Instant) -> bool {
        if !self.ready || now < started || now.duration_since(started) >= INTENT_TTL {
            return false;
        }
        self.prepare(started);
        true
    }
    pub fn prepare(&mut self, now: Instant) {
        if !self.ready {
            return;
        }
        self.invalidate();
        self.consent = true;
        self.intent = Some(now);
    }
    pub fn consume(&mut self, now: Instant) -> bool {
        self.intent
            .take()
            .is_some_and(|start| now >= start && now.duration_since(start) < INTENT_TTL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_and_navigation_invalidate_inflight_work() {
        let mut session = Session {
            ready: true,
            ..Session::default()
        };
        let now = Instant::now();
        session.prepare(now);
        let before = session.generation;
        session.invalidate();
        assert_ne!(before, session.generation);
        assert!(!session.consume(now));
        assert!(
            session.consent,
            "app consent is session-only, not a capture lease"
        );
    }
    #[test]
    fn missing_interfaces_or_handler_failure_cannot_remember_consent() {
        let mut session = Session::default();
        let now = Instant::now();
        session.prepare(now);
        assert!(!session.consent);
        assert!(!session.consume(now));
    }
    #[test]
    fn origin_is_parsed_and_never_renderer_supplied() {
        for origin in ["http://tauri.localhost", "http://localhost:1420"] {
            let trust = Trust(Url::parse(origin).unwrap());
            assert!(trust.matches(&format!("{origin}/chat?q=1#fragment")));
            for uri in [
                "https://tauri.localhost",
                "http://tauri.localhost.evil",
                "http://localhost:1421",
                "http://evil@tauri.localhost",
                "http://tauri.localhost:81",
                "data:text/plain,test",
                "file:///tmp/app",
                "null",
                "http://localhost:1420@evil",
            ] {
                assert!(!trust.matches(uri), "{origin} must reject {uri}");
            }
        }
        assert!(Trust(Url::parse("http://tauri.localhost").unwrap())
            .matches("http://TAURI.LOCALHOST:80/"));
    }
    fn trusted_request() -> Request<'static> {
        Request {
            window: "main",
            source: "http://tauri.localhost/chat",
            uri: "http://tauri.localhost",
            microphone_only: true,
            top_frame: true,
            user_initiated: true,
            saved_denied: false,
            generation: 1,
        }
    }
    #[test]
    fn every_native_gate_is_required() {
        let trust = Trust(Url::parse("http://tauri.localhost").unwrap());
        let good = trusted_request();
        let bad = [
            Request {
                window: "other",
                ..good.clone()
            },
            Request {
                source: "https://evil.invalid",
                ..good.clone()
            },
            Request {
                uri: "https://evil.invalid",
                ..good.clone()
            },
            Request {
                microphone_only: false,
                ..good.clone()
            },
            Request {
                top_frame: false,
                ..good.clone()
            },
            Request {
                user_initiated: false,
                ..good.clone()
            },
            Request {
                saved_denied: true,
                ..good.clone()
            },
            Request {
                generation: 0,
                ..good.clone()
            },
        ];
        for (index, request) in bad.iter().enumerate() {
            let mut session = Session {
                ready: true,
                ..Session::default()
            };
            let now = Instant::now();
            session.prepare(now);
            assert!(
                !session.authorize(&trust, request, now),
                "unsafe case {index}"
            );
        }
        let mut session = Session {
            ready: true,
            ..Session::default()
        };
        let now = Instant::now();
        session.prepare(now);
        assert!(session.authorize(&trust, &good, now));
        assert!(!session.authorize(&trust, &good, now));
    }
    #[test]
    fn preflight_preserves_saved_denial_and_cancelled_generation() {
        let trust = Trust(Url::parse("http://tauri.localhost").unwrap());
        let mut session = Session {
            ready: true,
            ..Session::default()
        };
        assert!(!session.can_prepare(&trust, "http://tauri.localhost", "main", 0, true));
        assert!(!session.can_prepare(&trust, "http://tauri.localhost", "other", 0, false));
        assert!(!session.can_prepare(&trust, "http://evil", "main", 0, false));
        session.invalidate();
        assert!(!session.can_prepare(&trust, "http://tauri.localhost", "main", 0, false));
        assert!(session.can_prepare(&trust, "http://tauri.localhost", "main", 1, false));
        session.ready = false;
        assert!(!session.can_prepare(&trust, "http://tauri.localhost", "main", 1, false));
    }
    #[test]
    fn timed_out_preflight_cannot_remember_consent_or_arm_capture() {
        let mut session = Session {
            ready: true,
            ..Session::default()
        };
        let started = Instant::now();
        assert!(!session.complete_prepare(started, started + INTENT_TTL));
        assert!(!session.consent);
        assert!(!session.consume(started + INTENT_TTL));
        assert!(session.complete_prepare(started, started + Duration::from_millis(1)));
    }
    #[test]
    fn intent_expires_at_the_deadline() {
        let mut session = Session {
            ready: true,
            ..Session::default()
        };
        let now = Instant::now();
        session.prepare(now);
        assert!(!session.consume(now + INTENT_TTL));
    }
    #[test]
    fn explicit_preparation_authorizes_one_recording() {
        let mut session = Session {
            ready: true,
            ..Session::default()
        };
        let now = Instant::now();
        session.prepare(now);
        assert!(session.consent);
        assert!(session.consume(now));
        assert!(
            !session.consume(now),
            "recording intent must not be replayed"
        );
    }
}
