import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { RootView } from './__root';
import { NavigationToggle } from '../components/ResponsiveShell';

vi.mock('#platform-shell', () => ({ PlatformDialogs: () => null, PlatformTitlebar: () => null, PlatformUpdateToast: () => null, usePlatformLifecycle: () => {} }));
vi.mock('@tanstack/react-router', () => ({ Outlet: () => <div>Conversation content</div>, useNavigate: () => vi.fn(), useRouterState: () => '/channel/a' }));
vi.mock('../components/Sidebar', () => ({ Sidebar: () => <button>General channel</button> }));
vi.mock('../components/ChatHeader', () => ({ ChatHeader: () => <NavigationToggle /> }));
vi.mock('../CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../components/AuthModal', () => ({ AuthModal: () => null, AuthOnboarding: () => <div>Log in</div> }));
vi.mock('../components/WorkspaceModal', () => ({ WorkspaceModal: () => null, openWorkspaceModal: vi.fn() }));
vi.mock('../components/ChannelModal', () => ({ ChannelModal: () => null }));
vi.mock('../components/HermesBotModal', () => ({ HermesBotModal: () => null }));

it('composes mobile navigation into the authenticated root and closes it on route changes', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const { container, rerender } = render(<RootView authLoading={false} authenticated routeKey='/channel/a' />);
  await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
  expect(screen.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible();
  expect(container.querySelector('.app-viewport')).toBeTruthy();
  rerender(<RootView authLoading={false} authenticated routeKey='/channel/b' />);
  expect(screen.queryByRole('dialog', { name: 'Workspace navigation' })).not.toBeInTheDocument();
  expect(screen.getByText('Conversation content')).toBeVisible();
  vi.unstubAllGlobals();
});
