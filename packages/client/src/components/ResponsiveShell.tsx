import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { HeaderActionsProvider } from "./HeaderActions";

export const MOBILE_NAV_QUERY = "(max-width: 1023px)";

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia?.(query);
      media?.addEventListener("change", notify);
      return () => media?.removeEventListener("change", notify);
    },
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

const NavigationContext = createContext<{ mobile: boolean; open: boolean; close: () => void } | null>(null);
export const useNavigationDismiss = () => useContext(NavigationContext)?.close;

/** Shared layout only: auth, router and desktop startup stay with the caller. */
export function ResponsiveShell({ navigation, children, routeKey }: {
  navigation: ReactNode; children: ReactNode; routeKey: string;
}) {
  const mobile = useMediaQuery(MOBILE_NAV_QUERY);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [routeKey, mobile]);
  useEffect(() => {
    const dismiss = () => setOpen(false);
    window.addEventListener("popstate", dismiss);
    return () => window.removeEventListener("popstate", dismiss);
  }, []);
  return (
    <HeaderActionsProvider>
      <NavigationContext.Provider value={{ mobile, open, close: () => setOpen(false) }}>
        <Dialog.Root open={mobile && open} onOpenChange={setOpen}>
          <div className="responsive-shell">
            {mobile ? (
              <Dialog.Portal>
                <Dialog.Overlay className="mobile-drawer-overlay" />
                <Dialog.Content className="mobile-drawer mobile-navigation" aria-describedby={undefined}>
                  <div className="mobile-drawer-heading">
                    <Dialog.Title>Workspace navigation</Dialog.Title>
                    <Dialog.Close className="mobile-touch-button" aria-label="Close navigation">✕</Dialog.Close>
                  </div>
                  <nav aria-label="Workspace navigation" className="mobile-navigation-content">{navigation}</nav>
                </Dialog.Content>
              </Dialog.Portal>
            ) : navigation}
            <div className="responsive-shell-main">{children}</div>
          </div>
        </Dialog.Root>
      </NavigationContext.Provider>
    </HeaderActionsProvider>
  );
}

export function NavigationToggle() {
  const navigation = useContext(NavigationContext);
  if (!navigation?.mobile) return null;
  return (
    <Dialog.Trigger className="mobile-touch-button" aria-label="Open navigation" aria-expanded={navigation.open}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M3 5h14M3 10h14M3 15h14" />
      </svg>
    </Dialog.Trigger>
  );
}
