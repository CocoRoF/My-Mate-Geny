/**
 * Avatar Create (아바타 만들기) in the Mate view (docs/avatar-create.md): a dedicated conversation with the avatar agent
 * — separate from the mate's own chat — next to the project panel (estimate, checkpoints, progress, the finished
 * avatar playing, Apply). Desktop: the panel on the left (where she stands), the conversation on the right. Phone:
 * two tabs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { avatarEnv, createProject, deleteProject, getProject, listProjects, type AvatarEnv, type AvatarProject, type ProjectSummary } from "../../../api/avatar";
import type { Mate } from "../../../api/mates";
import { usePhone } from "../../../lib/device";
import { useAvatarCreate } from "../../../stores/avatarCreateStore";
import { useMateStore } from "../../../stores/mateStore";
import { useLang, useT, type MsgKey } from "../../../i18n";
import Icon from "../../ui/Icon";
import AvatarChat from "./AvatarChat";
import AvatarPanel, { StatusPill, type Act } from "./AvatarPanel";
import { useAgentChat } from "./useAgentChat";

const LIVE = new Set(["running", "waiting"]);

export default function AvatarCreate({ mate }: { mate: Mate | null }) {
  const t = useT();
  const lang = useLang();
  const phone = usePhone();
  const projectId = useAvatarCreate((s) => s.projectId);
  const mateId = useAvatarCreate((s) => s.mateId);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [project, setProject] = useState<AvatarProject | null>(null);
  const [env, setEnv] = useState<AvatarEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"chat" | "project">("chat");
  const target = mateId ? (useMateStore.getState().mates.find((m) => m.id === mateId) ?? mate) : null;

  const reloadEnv = useCallback(() => {
    avatarEnv().then(setEnv).catch(() => {});
  }, []);
  useEffect(reloadEnv, [reloadEnv]);

  useEffect(() => {
    if (projectId) return;
    listProjects()
      .then(setProjects)
      .catch((e) => setError((e as Error).message));
  }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const p = await getProject(projectId);
      setProject(p);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);
  useEffect(() => {
    setProject(null);
    void load();
  }, [load]);
  // live while it runs (or the agent works): the panel follows the server
  const live = !!project && (LIVE.has(project.status) || project.agent_running || !!project.processing);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!projectId) return;
    const timer = setInterval(() => void loadRef.current(), live ? 2500 : 12000);
    return () => clearInterval(timer);
  }, [projectId, live]);

  const chat = useAgentChat(project?.session_id ?? null, () => void loadRef.current());

  const act: Act = async (fn) => {
    setBusy(true);
    try {
      const r = (await fn()) as any;
      if (r && typeof r === "object") {
        if ("project" in r && r.project) setProject(r.project);
        else if ("id" in r && "brief" in r) setProject(r as AvatarProject);
        if (r.mate) useMateStore.getState().upsert(r.mate);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const p = await createProject({ mate_id: mateId, language: lang });
      useAvatarCreate.getState().setProject(p.id);
      setProject(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const close = () => useAvatarCreate.getState().close();
  const header = (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 bg-surface/80 px-3 backdrop-blur-xl" data-testid="avatar-header">
      <button className="btn-ghost !px-2" onClick={close} aria-label={t("avatar.close")} data-testid="avatar-close">
        <Icon name="chevron-left" size={16} />
      </button>
      <Icon name="sparkles" size={15} className="text-accent" />
      <span className="truncate text-[14px] font-semibold">{t("avatar.title")}</span>
      {project && <span className="truncate text-[12.5px] text-content-dim">· {project.title}</span>}
      {project && <StatusPill project={project} />}
      <div className="ml-auto flex items-center gap-1">
        {projectId && (
          <button className="btn-ghost !px-2 text-[12px]" onClick={() => useAvatarCreate.getState().setProject(null)} data-testid="avatar-projects">
            <Icon name="files" size={14} /> {!phone && t("avatar.projects")}
          </button>
        )}
      </div>
    </div>
  );

  if (!projectId) {
    const mine = (projects || []).filter((p) => !mateId || p.mate_id === mateId || !p.mate_id);
    return (
      <div className="flex h-full flex-col" data-testid="avatar-create">
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-xl space-y-4 p-5">
            <div className="rounded-2xl border border-accent/30 bg-accent-soft/30 p-5" data-testid="avatar-intro">
              <h2 className="text-[16px] font-semibold">{target ? t("avatar.introFor", { name: target.name }) : t("avatar.introNew")}</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-content-dim">{t("avatar.introBody")}</p>
              <ul className="mt-3 space-y-1 text-[12.5px] text-content-dim">
                {(["avatar.introStep1", "avatar.introStep2", "avatar.introStep3", "avatar.introStep4"] as MsgKey[]).map((k) => (
                  <li key={k} className="flex gap-2">
                    <Icon name="check" size={13} className="mt-0.5 shrink-0 text-accent" /> {t(k)}
                  </li>
                ))}
              </ul>
              <button className="btn-primary mt-4" onClick={start} disabled={busy} data-testid="avatar-start">
                {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="sparkles" size={14} />} {t("avatar.start")}
              </button>
              {env && !env.higgsfield.connected && <p className="mt-2 text-[12px] text-warning">{t("avatar.connectHiggsfield")}</p>}
            </div>
            {mine.length > 0 && (
              <div>
                <h3 className="mb-2 text-[12.5px] font-medium text-content-dim">{t("avatar.earlier")}</h3>
                <ul className="divide-y divide-border/60 rounded-xl border border-border">
                  {mine.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => useAvatarCreate.getState().setProject(p.id)} data-testid="avatar-project-item">
                        {p.thumb ? <img src={p.thumb} alt="" className="h-9 w-9 rounded object-cover" /> : <Icon name="user" size={16} className="text-content-faint" />}
                        <span className="min-w-0 flex-1 truncate text-[13px]">{p.title}</span>
                        <span className="text-[11.5px] text-content-faint">{t(`avatar.status_${p.status}` as MsgKey)}</span>
                      </button>
                      {!LIVE.has(p.status) && (
                        <button
                          className="btn-ghost !px-1.5 text-content-faint"
                          aria-label={t("common.delete")}
                          onClick={() => window.confirm(t("avatar.deleteConfirm", { name: p.title })) && deleteProject(p.id).then(() => setProjects((x) => (x || []).filter((y) => y.id !== p.id)))}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && <p className="text-[12px] text-danger">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  const banner = error && (
    <div className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-danger/10 px-3 py-1.5 text-[12px] text-danger" data-testid="avatar-error">
      <Icon name="warning" size={12} />
      <span className="min-w-0 flex-1 break-words">{error}</span>
      <button onClick={() => setError(null)} aria-label={t("common.dismiss")}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
  if (!project) {
    return (
      <div className="flex h-full flex-col" data-testid="avatar-create">
        {header}
        {banner}
        <div className="grid flex-1 place-items-center text-content-faint">
          <Icon name="spinner" size={18} spin />
        </div>
      </div>
    );
  }
  const panel = <AvatarPanel project={project} env={env} act={act} reloadEnv={reloadEnv} />;
  const conversation = <AvatarChat project={project} env={env} act={act} chat={chat} />;
  if (phone) {
    return (
      <div className="flex h-full flex-col" data-testid="avatar-create">
        {header}
        <div className="flex shrink-0 gap-1 border-b border-border/60 px-3 py-1.5">
          <button className="nav-tab flex-1" data-active={tab === "chat"} onClick={() => setTab("chat")} data-testid="avatar-tab-chat">
            {t("avatar.tabChat")}
          </button>
          <button className="nav-tab flex-1" data-active={tab === "project"} onClick={() => setTab("project")} data-testid="avatar-tab-project">
            {t("avatar.tabProject")}
            {(project.status === "waiting" || (project.status === "estimate" && !!project.plan)) && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent" />}
          </button>
        </div>
        {banner}
        {tab === "chat" ? conversation : <div className="min-h-0 flex-1 overflow-y-auto">{panel}</div>}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col" data-testid="avatar-create">
      {header}
      {banner}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-[340px] flex-1 basis-0 overflow-y-auto border-r border-border/60">{panel}</div>
        <div className="flex min-h-0 min-w-[360px] flex-1 basis-0 flex-col">{conversation}</div>
      </div>
      {busy && <span className="sr-only">{t("common.loading")}</span>}
    </div>
  );
}
