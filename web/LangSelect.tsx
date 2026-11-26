import { MenuButton } from "@xdev-asia/ui";
import { t, useLang, type Lang } from "./i18n";

export const LANGS: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

/** The language control: an icon button in the top bar, the languages in its menu. */
export function LangSelect() {
  const [lang, setLang] = useLang();
  return (
    <MenuButton
      variant="icon"
      icon="globe"
      align="end"
      label={t("shell.lang")}
      items={LANGS.map((l) => ({ label: l.label, checked: lang === l.value, onSelect: () => setLang(l.value) }))}
    />
  );
}
