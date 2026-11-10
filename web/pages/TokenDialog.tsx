import { Banner, CodeBlock, Dialog, Stack } from "@xdev-asia/ui";
import { t, useLang } from "../i18n";
import { ui } from "../ui-labels";

const sdkSnippet = (token: string, origin: string) => `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "${token}",
  baseURL: "${origin}/anthropic",
});`;

/** Shows a system token once, after create or rotate. Closing it is the only way out; it is not shown again. */
export function TokenDialog({ id, token, onClose }: { id: string; token: string; onClose: () => void }) {
  const [lang] = useLang();
  const labels = ui(lang);
  return (
    <Dialog
      modal
      size="wide"
      body="plain"
      title={t("token.title", { id })}
      confirmLabel={t("common.close")}
      cancelLabel={null}
      labels={labels.dialog}
      onConfirm={onClose}
      onCancel={onClose}
    >
      <Stack gap={3}>
        <Banner tone="warn" title={t("token.once")} />
        <CodeBlock code={token} labels={labels.codeBlock} />
        <p className="muted">{t("token.key", { id })}</p>
        <h3 className="dialog-subheading">{t("token.sdk")}</h3>
        <CodeBlock code={sdkSnippet(token, window.location.origin)} language="ts" labels={labels.codeBlock} />
      </Stack>
    </Dialog>
  );
}
