import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Toast } from "@xdev-asia/ui";
import { useLang } from "./i18n";
import { ui } from "./ui-labels";

export type Notify = (message: string) => void;

export const NotifyContext = createContext<Notify>(() => {});
export const useNotify = (): Notify => useContext(NotifyContext);

/** Holds the toast list: pass `toasts` to AppShell and `notify` to NotifyContext. */
export function useToasts(): { notify: Notify; toasts: ReactNode } {
  const [lang] = useLang();
  const [items, setItems] = useState<{ id: number; text: string }[]>([]);
  const next = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), []);
  const notify = useCallback<Notify>(
    (text) => {
      const id = next.current++;
      setItems((l) => [...l.slice(-2), { id, text }]);
      timers.current.add(setTimeout(() => dismiss(id), 5000));
    },
    [dismiss],
  );
  useEffect(() => {
    const all = timers.current;
    return () => all.forEach(clearTimeout);
  }, []);
  const toasts = items.map((x) => (
    <Toast key={x.id} labels={ui(lang).toast} onDismiss={() => dismiss(x.id)}>
      {x.text}
    </Toast>
  ));
  return { notify, toasts };
}
