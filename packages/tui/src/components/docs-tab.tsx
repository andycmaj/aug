// The Docs tab: every link and doc Riker holds (core/documents.ts), newest
// first, one row per address with every task and project it belongs to.
// Enter opens a row in place; o opens the link (a web address in the
// browser, a file in $EDITOR); x takes it off where it was attached and
// changes nothing outside Riker. Nothing here fetches a page.

import { createMemo, createSignal, For, Show } from "solid-js";
import { truncate, useTheme } from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useRiker } from "../context/riker";
import {
  DocSource,
  groupOf,
  inKind,
  inProject,
  KIND_WORDS,
  matchesDoc,
  nextKind,
  nextProject,
  projectChoices,
  removable,
  type DocKind,
  type DocOwner,
  type DocRow,
  type ProjectFilter,
} from "@riker/core/documents";
import { parseTaskRef, taskRef } from "@riker/core/rows";
import type { HelpCtx } from "../keymap";
import type { Actions, Dialogs } from "./actions";
import {
  askSearch,
  ExpandList,
  FilterPills,
  listCursor,
  selColor,
  when,
  type ListEntry,
} from "./expand-list";
import { ChoiceModal, PromptModal } from "./modals";
import { useToast } from "../context/toast";

type Handler = () => false | void;

// Kept across tab switches, like the Board's tab.
const [kind, setKind] = createSignal<DocKind | null>(null);
const [project, setProject] = createSignal<ProjectFilter>(null);
const [grouped, setGrouped] = createSignal(false);
const [query, setQuery] = createSignal("");
const cursor = listCursor();

export function useDocsTab(opts: {
  active: () => boolean;
  actions: Actions;
  dialogs: Dialogs;
}) {
  const riker = useRiker();
  const { showToast } = useToast();
  const all = createMemo(() => (opts.active() ? riker.documents() : []));
  const shown = createMemo(() =>
    all().filter(
      (r) =>
        inKind(r, kind()) && inProject(r, project()) && matchesDoc(r, query()),
    ),
  );
  const projectName = (id: number | null) =>
    id === null ? "No project" : (riker.project(id)?.name ?? `project ${id}`);
  // Grouped, the cursor walks the rows in the order they are drawn.
  const groups = createMemo(() => {
    if (!grouped()) {
      return null;
    }
    const by = new Map<number | null, DocRow[]>();
    for (const r of shown()) {
      const g = groupOf(r);
      by.set(g, [...(by.get(g) ?? []), r]);
    }
    // Newest group first; rows already newest first.
    return [...by.entries()].sort(([a], [b]) =>
      a === null ? 1 : b === null ? -1 : 0,
    );
  });
  const rows = createMemo(
    () => groups()?.flatMap(([, list]) => list) ?? shown(),
  );
  const row = (): DocRow | null => rows()[cursor.index(rows().length)] ?? null;

  const move = (d: number) => cursor.move(d, rows().length);
  const refilter = () => cursor.reset();

  const onRow =
    (fn: (r: DocRow) => false | void): Handler =>
    () => {
      if (!opts.active()) {
        return false;
      }
      const r = row();
      if (!r) {
        return false;
      }
      return fn(r);
    };

  const ownerWords = (o: DocOwner) =>
    o.taskId !== null
      ? `${taskRef(o.taskId)} ${riker.task(o.taskId)?.title ?? ""}`.trim()
      : o.projectId !== null
        ? `${projectName(o.projectId)} (project)`
        : "Riker";

  const pick = (
    title: string,
    owners: DocOwner[],
    run: (o: DocOwner) => void,
  ) => {
    if (owners.length === 1) {
      run(owners[0]);
      return;
    }
    opts.dialogs.show(() => (
      <ChoiceModal
        title={title}
        choices={owners.map((o) => ({
          label: ownerWords(o),
          hint: o.source,
          run: () => run(o),
        }))}
        onClose={opts.dialogs.close}
      />
    ));
  };

  const goTo = (o: DocOwner) => {
    if (o.taskId !== null) {
      opts.actions.goToTask(o.taskId);
    } else if (o.projectId !== null) {
      opts.actions.goToProject(o.projectId);
    }
  };

  const remove = (r: DocRow, o: DocOwner) => {
    const where = ownerWords(o);
    opts.dialogs.show(() => (
      <ChoiceModal
        title={`Take ${truncate(r.title, 40)} off ${truncate(where, 40)}?`}
        hint="Only Riker's link goes; the page or file is untouched."
        choices={[
          {
            label: "Yes, take it off",
            run: () => {
              const ok =
                o.source === DocSource.projectLink
                  ? riker.desk.unlinkProject(o.projectId!, o.stored)
                  : riker.desk.unlink(o.taskId!, o.stored);
              showToast(ok ? `Taken off ${where}` : "It was already gone");
            },
          },
          { label: "No", run: () => {} },
        ]}
        onClose={opts.dialogs.close}
      />
    ));
  };

  const attach = (r: DocRow) => {
    opts.dialogs.show(() => (
      <PromptModal
        title={`Attach ${truncate(r.title, 40)} to a task`}
        hint="The task's ref, as RIKER-0012 or 12."
        onSubmit={(text) => {
          const id = parseTaskRef(text.trim()) ?? (Number(text.trim()) || null);
          const task = id ? riker.task(id) : null;
          if (!task) {
            showToast(`No task ${text.trim()}`, 4000, "error");
            return;
          }
          const stored =
            r.owners.find((o) => o.title)?.stored ?? r.owners[0].stored;
          const title = r.owners.some((o) => o.title) ? r.title : null;
          riker.desk.link(task.id, stored, title, "you");
          showToast(`Attached to ${taskRef(task.id)}`);
        }}
        onClose={opts.dialogs.close}
      />
    ));
  };

  const commands: Record<string, Handler> = {
    [Commands.DOCUMENTS_EXPAND]: onRow((r) => cursor.toggle(r.key)),
    [Commands.DOCUMENTS_OPEN_LINK]: onRow((r) => opts.actions.openLink(r.url)),
    [Commands.DOCUMENTS_GO]: onRow((r) => {
      const owners = r.owners.filter(
        (o) => o.taskId !== null || o.projectId !== null,
      );
      if (!owners.length) {
        return false;
      }
      pick("Go to", owners, goTo);
    }),
    [Commands.DOCUMENTS_COPY]: onRow((r) => opts.actions.copyText(r.url)),
    [Commands.DOCUMENTS_ATTACH]: onRow(attach),
    [Commands.DOCUMENTS_REMOVE]: onRow((r) => {
      const owners = r.owners.filter(removable);
      if (!owners.length) {
        return false;
      }
      pick("Take it off", owners, (o) => remove(r, o));
    }),
    [Commands.DOCUMENTS_KIND]: () => {
      if (!opts.active()) {
        return false;
      }
      setKind(nextKind(kind()));
      refilter();
    },
    [Commands.DOCUMENTS_PROJECT]: () => {
      if (!opts.active()) {
        return false;
      }
      setProject(nextProject(project(), projectChoices(all())));
      refilter();
    },
    [Commands.DOCUMENTS_GROUP]: () => {
      if (!opts.active()) {
        return false;
      }
      setGrouped((g) => !g);
      refilter();
    },
    [Commands.DOCUMENTS_SEARCH]: () => {
      if (!opts.active()) {
        return false;
      }
      askSearch(
        opts.dialogs,
        query(),
        (text) => {
          setQuery(text);
          refilter();
        },
        {
          title: "Search the Docs",
          hint: "Title, address, kind, host, task (RIKER-0012 or its title) or project. / again clears it.",
        },
      );
    },
  };

  const ctx = (): Partial<HelpCtx> => {
    const r = row();
    if (!r) {
      return { item: null };
    }
    return {
      item: "doc",
      docOwned: r.owners.some((o) => o.taskId !== null || o.projectId !== null),
      docRemovable: r.owners.some(removable),
    };
  };

  const counts = createMemo(() => {
    const out = new Map<DocKind | null, number>([[null, 0]]);
    for (const r of all().filter(
      (r) => inProject(r, project()) && matchesDoc(r, query()),
    )) {
      out.set(null, (out.get(null) ?? 0) + 1);
      out.set(r.kind, (out.get(r.kind) ?? 0) + 1);
    }
    return out;
  });

  return {
    commands,
    ctx,
    move,
    subject: () => {
      const r = opts.active() ? row() : null;
      return r ? `${KIND_WORDS[r.kind]} ${r.title}` : null;
    },
    View: (props: { width: number }) => (
      <DocsView
        onRow={(key) =>
          cursor.press(
            rows().map((r) => r.key),
            key,
          )
        }
        onPill={(i) => {
          setKind(KIND_PILLS[i]);
          refilter();
        }}
        rows={shown()}
        groups={groups()}
        selected={row()?.key ?? null}
        openKey={cursor.openKey()}
        kind={kind()}
        counts={counts()}
        project={
          project() === null
            ? null
            : project() === "none"
              ? "No project"
              : projectName(project() as number)
        }
        grouped={grouped()}
        query={query()}
        total={all().length}
        projectName={projectName}
        ownerWords={ownerWords}
        width={props.width}
      />
    ),
  };
}

const KIND_PILLS: (DocKind | null)[] = [
  null,
  "pr",
  "issue",
  "doc",
  "thread",
  "file",
  "other",
];

function DocsView(props: {
  onRow: (key: string) => void;
  onPill: (index: number) => void;
  rows: DocRow[];
  groups: [number | null, DocRow[]][] | null;
  selected: string | null;
  openKey: string | null;
  kind: DocKind | null;
  counts: Map<DocKind | null, number>;
  project: string | null;
  grouped: boolean;
  query: string;
  total: number;
  projectName: (id: number | null) => string;
  ownerWords: (o: DocOwner) => string;
  width: number;
}) {
  const theme = useTheme();
  const riker = useRiker();

  const entries = createMemo((): ListEntry<DocRow>[] => {
    if (!props.groups) {
      return props.rows.map((row) => ({ row }));
    }
    return props.groups.flatMap(([id, list], i) => [
      {
        key: `group-${id ?? "none"}`,
        heading: () => (
          <text marginTop={i === 0 ? 0 : 1}>
            <span style={{ fg: theme.accent, attributes: 1 }}>
              {props.projectName(id)}
            </span>
            <span style={{ fg: theme.textMuted }}>{`  ${list.length}`}</span>
          </text>
        ),
      },
      ...list.map((row) => ({ row })),
    ]);
  });

  // Owners in the last column: the newest, and how many more.
  const ownerCol = (r: DocRow) => {
    const first = r.owners[0];
    const word =
      first.taskId !== null
        ? `${taskRef(first.taskId)}${first.projectId !== null ? ` ${props.projectName(first.projectId)}` : ""}`
        : first.projectId !== null
          ? props.projectName(first.projectId)
          : "Riker";
    return r.owners.length > 1 ? `${word} +${r.owners.length - 1}` : word;
  };
  const titleWidth = () => Math.max(16, props.width - 7 - 7 - 22 - 26 - 12);

  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} paddingLeft={1}>
      <box flexShrink={0} paddingBottom={1} flexDirection="column">
        <FilterPills
          pills={KIND_PILLS.map((k) => ({
            word: k === null ? "all" : KIND_WORDS[k],
            count: props.counts.get(k) ?? 0,
            on: k === props.kind,
          }))}
          hint="f kind · p project · P group"
          query={props.query}
          onPill={props.onPill}
        >
          <Show when={props.project}>
            <text fg={theme.accent}>{`project: ${props.project}`}</text>
          </Show>
          <Show when={props.grouped}>
            <text fg={theme.accent}>by project</text>
          </Show>
        </FilterPills>
      </box>
      <Show
        when={props.rows.length > 0}
        fallback={
          <text fg={theme.textMuted}>
            {props.total === 0
              ? "No links or docs yet. move link attaches one to a task, project_link to a project; PRs, journals and files agents make show here too."
              : props.query
                ? "Nothing matches. / clears the search."
                : "Nothing under these filters. f and p cycle back to all."}
          </text>
        }
      >
        <ExpandList
          id="docs"
          onPress={props.onRow}
          entries={entries()}
          rowKey={(r) => r.key}
          selected={props.selected}
          openKey={props.openKey}
          row={(r, sel) => {
            const fg = selColor(theme, sel);
            return (
              <>
                <text fg={fg(theme.textMuted)} width={7} flexShrink={0}>
                  {when(r.at, riker.now())}
                </text>
                <text fg={fg(theme.secondary)} width={7} flexShrink={0}>
                  {KIND_WORDS[r.kind]}
                </text>
                <text fg={fg(theme.text)} flexGrow={1}>
                  {truncate(r.title, titleWidth())}
                </text>
                <text fg={fg(theme.textMuted)} width={22} flexShrink={0}>
                  {truncate(r.host, 22)}
                </text>
                <text fg={fg(theme.textMuted)} width={26} flexShrink={0}>
                  {truncate(ownerCol(r), 26)}
                </text>
              </>
            );
          }}
          detail={(r) => (
            <Detail row={r} ownerWords={props.ownerWords} width={props.width} />
          )}
        />
      </Show>
    </box>
  );
}

function stamp(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.toTimeString().slice(0, 5)}`;
}

// The open row: the whole address, then each owner with how it got there.
function Detail(props: {
  row: DocRow;
  ownerWords: (o: DocOwner) => string;
  width: number;
}) {
  const theme = useTheme();
  const width = () => Math.max(20, props.width - 8);
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.contentPane}
    >
      <text fg={theme.text} wrapMode="char">
        {props.row.url}
      </text>
      <For each={props.row.owners}>
        {(o) => (
          <text fg={theme.textMuted}>
            {truncate(
              [
                props.ownerWords(o),
                o.source,
                o.title && o.title !== props.row.title ? `"${o.title}"` : null,
                o.by ? `by ${o.by}` : null,
                stamp(o.at),
                o.note,
              ]
                .filter(Boolean)
                .join(" · "),
              width(),
            )}
          </text>
        )}
      </For>
    </box>
  );
}
