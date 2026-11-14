import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, CodeBlock, Emblem, EmptyState, Grid, List, ListRow, Skeleton, Stack, type IconName } from "@xdev-asia/ui";
import { t, useLang } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";

/** One entry of the public GET /skills (worker/skills.ts). */
export interface SkillFile {
  name: string;
  description: string;
  url: string;
}

type State = { status: "loading" } | { status: "error" } | { status: "ready"; data: SkillFile[] };

const ICONS: Record<string, IconName> ={ "ai-router": "chat", media: "image", web: "globe" };

/**
 * Skills: the Markdown files the gateway serves at /skills for an agent to read. The list is public,
 * so it is fetched without the /admin prefix; the files hold no token.
 */
export function Skills() {
  const [lang] = useLang();
  const notify = useNotify();
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fetch("/skills")
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as SkillFile[];
        if (live) setState({ status: "ready", data: Array.isArray(data) ? data : [] });
      })
      .catch(() => {
        if (live) setState({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(done);
    } catch {
      notify(t("skills.copyFailed"));
    }
  };

  if (state.status === "loading") return <Skeleton lines={4} announce labels={{ loading: t("loading") }} />;
  if (state.status === "error") {
    return (
      <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />
    );
  }

  const skills = state.data;
  if (skills.length === 0) return <EmptyState icon="book" title={t("skills.empty")} />;

  return (
    <Grid columns={{ base: 1, lg: 2 }} gap={6}>
      <Card
        headingLevel={2}
        title={t("skills.files")}
        subtitle={t("skills.count", { n: String(skills.length) })}
        actions={
          <Button size="sm" icon="copy" onClick={() => copy(skills.map((s) => s.url).join("\n"), t("skills.copiedAll"))}>
            {t("skills.copyAll")}
          </Button>
        }
        flush
      >
        <List>
          {skills.map((skill) => (
            <ListRow
              key={skill.name}
              as="li"
              leading={<Emblem name={skill.name} icon={ICONS[skill.name] ?? "book"} />}
              title={skill.name}
              meta={
                <Stack gap={1} as="span">
                  <span>{skill.description}</span>
                  <code>{skill.url}</code>
                </Stack>
              }
              trailing={
                <Stack direction="row" gap={2} as="span">
                  <Button size="sm" icon="copy" onClick={() => copy(skill.url, t("skills.copied", { name: skill.name }))}>
                    {t("skills.copyLink")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="external"
                    href={skill.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t("skills.open", { name: skill.name })}
                  />
                </Stack>
              }
            />
          ))}
        </List>
      </Card>
      <Card headingLevel={2} title={t("skills.howTitle")}>
        <Stack gap={3}>
          <p>{t("skills.howBody")}</p>
          <CodeBlock code={t("skills.prompt", { url: skills[0].url })} language="text" labels={ui(lang).codeBlock} />
        </Stack>
      </Card>
    </Grid>
  );
}
