import { Select } from "@xdev-asia/ui";
import { t, useLang, type Lang } from "./i18n";

/** Native names: each language is labelled in itself, whatever the active language. */
const LANGS = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

export function LangSelect() {
  const [lang, setLang] = useLang();
  return <Select icon="globe" options={LANGS} value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("shell.lang")} />;
}
