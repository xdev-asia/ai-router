import { CommandPalette, type IconName, type PaletteRow } from "@xdev-asia/ui";
import { useLoad, type Provider } from "./api";
import { t, type StringKey } from "./i18n";

/** A page the palette can open: its hash, its sidebar name and icon. */
export interface PaletteTarget {
  id: string;
  nav: StringKey;
  icon: IconName;
}

/**
 * Ctrl K: jump to a page or straight to a provider's page. Mounted only while open, so the provider list is
 * fetched when someone opens it, not on every page.
 */
export function ConsolePalette({ pages, onClose }: { pages: PaletteTarget[]; onClose: () => void }) {
  const [providers] = useLoad<Provider[]>("/providers");
  const pageRows: PaletteRow[] = pages.map((p) => ({ id: `#/${p.id}`, title: t(p.nav), icon: p.icon }));
  const providerRows: PaletteRow[] =
    providers.status === "ready" ? providers.data.map((p) => ({ id: `#/providers/${p.id}`, title: p.name, detail: p.id, icon: "plug" })) : [];
  return (
    <CommandPalette
      open
      onClose={onClose}
      onSelect={(row) => {
        if (row.id) window.location.hash = row.id;
        onClose();
      }}
      labels={{
        dialog: t("palette.dialog"),
        placeholder: t("palette.placeholder"),
        search: t("palette.search"),
        noMatches: t("palette.noMatches"),
        move: t("palette.move"),
        open: t("palette.open"),
        close: t("palette.close"),
      }}
      sections={[
        { title: t("palette.pages"), rows: pageRows },
        ...(providerRows.length ? [{ title: t("palette.providers"), rows: providerRows }] : []),
      ]}
    />
  );
}
