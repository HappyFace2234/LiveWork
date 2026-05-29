use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use chrono::Local;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio_cron_scheduler::{Job, JobScheduler};
use uuid::Uuid;

use crate::commands::settings::open_db;
use crate::runtime::shell_runner::{ShellRunResponse, run_shell_script};
use crate::runtime::task_runner::{
    HttpExecutionFailure, HttpExecutionResult, HttpRequestInput, build_http_client,
    resolve_workdir, run_single_http_request,
};
use crate::services::gateway::GatewayController;

const CRON_SETTINGS_TABLE: &str = "cron_settings";
const CRON_LOGS_TABLE: &str = "cron_execution_logs";
const SYSTEM_SETTINGS_TABLE: &str = "system_settings";
const SYSTEM_WORKDIR_KEY: &str = "workdir";
const MAX_LOG_OUTPUT_CHARS: usize = 50_000;
const DEFAULT_CRON_SCRIPT_TIMEOUT_MS: u64 = 60_000;
const PROMPT_RUN_TIMEOUT_MS: u64 = 5 * 60_000;
const PROMPT_PENDING_EVENT: &str = "cron:auto-prompt-pending";
const PROMPT_EXPIRED_EVENT: &str = "cron:auto-prompt-expired";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecutionLogRecord {
    pub id: String,
    pub task_id: String,
    pub started_at: i64,
    pub success: bool,
    pub duration_ms: u128,
    pub exit_code: Option<i32>,
    pub output: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCronSelectedModelPayload {
    #[serde(default)]
    custom_provider_id: String,
    #[serde(default)]
    model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCronTaskPayload {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    cron: String,
    #[serde(default)]
    enabled: bool,
    #[serde(rename = "type", default)]
    task_type: String,
    #[serde(default)]
    script: String,
    #[serde(default)]
    requests: Vec<HttpRequestInput>,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    remaining_executions: Option<Value>,
    selected_model: Option<StoredCronSelectedModelPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CronPromptRunRequest {
    pub execution_id: String,
    pub task_id: String,
    pub task_name: String,
    pub prompt: String,
    pub provider_id: String,
    pub model: String,
    pub started_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronCompletePromptRunInput {
    #[serde(default)]
    pub execution_id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CronPromptRunCompletionStatus {
    Completed,
    AlreadyFinished,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CronPromptRunCompletionResult {
    pub status: CronPromptRunCompletionStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CronPromptRunExpiredEvent {
    execution_id: String,
    task_id: String,
}

#[derive(Debug, Clone)]
struct RunnablePromptTask {
    task_name: String,
    provider_id: String,
    model: String,
    prompt: String,
    config_error: Option<String>,
}

#[derive(Debug, Clone)]
enum RunnableCronKind {
    Bash { script: String },
    Http { requests: Vec<HttpRequestInput> },
    Prompt { task: RunnablePromptTask },
}

#[derive(Debug, Clone)]
struct RunnableCronTask {
    id: String,
    cron: String,
    kind: RunnableCronKind,
}

#[derive(Debug, Clone, Default)]
struct CronRuntimeSnapshot {
    workdir: String,
    tasks: Vec<RunnableCronTask>,
}

#[derive(Debug, Clone)]
struct ActiveCronPromptRun {
    request: CronPromptRunRequest,
}

#[derive(Debug, Clone)]
struct PendingCronPromptRun {
    request: CronPromptRunRequest,
    completion_in_progress: bool,
}

#[derive(Debug, Clone)]
struct PromptRunCompletionLease {
    request: CronPromptRunRequest,
}

#[derive(Default)]
struct CronPromptRuntimeState {
    app_handle: Option<tauri::AppHandle>,
    active_prompt_runs: HashMap<String, ActiveCronPromptRun>,
    pending_prompt_runs: HashMap<String, PendingCronPromptRun>,
    prompt_watchdogs: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
}

pub struct CronManager {
    scheduler: AsyncMutex<Option<JobScheduler>>,
    scheduled_jobs: AsyncMutex<HashMap<String, Uuid>>,
    active_runs: Mutex<HashSet<String>>,
    prompt_state: Mutex<CronPromptRuntimeState>,
    settings_sync_controller: Mutex<Option<Weak<GatewayController>>>,
    reload_notify: Notify,
    reload_pending: AtomicBool,
}

impl Default for CronManager {
    fn default() -> Self {
        Self {
            scheduler: AsyncMutex::new(None),
            scheduled_jobs: AsyncMutex::new(HashMap::new()),
            active_runs: Mutex::new(HashSet::new()),
            prompt_state: Mutex::new(CronPromptRuntimeState::default()),
            settings_sync_controller: Mutex::new(None),
            reload_notify: Notify::new(),
            reload_pending: AtomicBool::new(false),
        }
    }
}

impl CronManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn attach_app_handle(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        let mut state = self
            .prompt_state
            .lock()
            .map_err(|_| "Cron prompt runtime lock poisoned".to_string())?;
        state.app_handle = Some(app_handle);
        Ok(())
    }

    pub fn attach_settings_sync_controller(
        &self,
        controller: Weak<GatewayController>,
    ) -> Result<(), String> {
        let mut guard = self
            .settings_sync_controller
            .lock()
            .map_err(|_| "Cron settings sync controller lock poisoned".to_string())?;
        *guard = Some(controller);
        Ok(())
    }

    pub fn start(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            self.run_reload_loop().await;
        });
    }

    pub fn request_reload(&self) {
        self.reload_pending.store(true, Ordering::SeqCst);
        self.reload_notify.notify_one();
    }

    fn handle_task_settings_changed(&self, changed: bool) {
        if !changed {
            return;
        }
        self.request_reload();
        self.notify_settings_sync_changed();
    }

    fn notify_settings_sync_changed(&self) {
        let controller = match self.settings_sync_controller.lock() {
            Ok(guard) => guard.as_ref().and_then(Weak::upgrade),
            Err(_) => None,
        };
        let Some(controller) = controller else {
            return;
        };

        tauri::async_runtime::spawn(async move {
            if let Err(error) = controller.refresh_settings_sync_from_db().await {
                eprintln!("refresh gateway settings sync after cron execution failed: {error}");
            }
        });
    }

    pub fn take_pending_prompt_runs(&self) -> Result<Vec<CronPromptRunRequest>, String> {
        let state = self
            .prompt_state
            .lock()
            .map_err(|_| "Cron prompt runtime lock poisoned".to_string())?;
        let mut runs = state
            .pending_prompt_runs
            .values()
            .filter(|run| !run.completion_in_progress)
            .map(|run| run.request.clone())
            .collect::<Vec<_>>();
        runs.sort_by(|left, right| {
            left.started_at
                .cmp(&right.started_at)
                .then_with(|| left.execution_id.cmp(&right.execution_id))
        });
        Ok(runs)
    }

    pub async fn complete_prompt_run(
        self: &Arc<Self>,
        input: CronCompletePromptRunInput,
    ) -> Result<CronPromptRunCompletionResult, String> {
        let execution_id = input.execution_id.trim();
        if execution_id.is_empty() {
            return Err("executionId cannot be empty.".to_string());
        }

        let lease = match self.begin_prompt_run_completion(execution_id, Some(&input.task_id))? {
            Some(lease) => lease,
            None => {
                return Ok(CronPromptRunCompletionResult {
                    status: CronPromptRunCompletionStatus::AlreadyFinished,
                });
            }
        };

        let output = if input.output.trim().is_empty() {
            if input.success {
                "Auto Prompt run produced an empty final conclusion.".to_string()
            } else {
                "Auto Prompt run failed without an error message.".to_string()
            }
        } else {
            input.output.trim().to_string()
        };

        let log = CronExecutionLogRecord {
            id: Uuid::new_v4().to_string(),
            task_id: lease.request.task_id.clone(),
            started_at: lease.request.started_at,
            success: input.success,
            duration_ms: normalize_run_duration_ms(lease.request.started_at, input.duration_ms),
            exit_code: None,
            output: truncate_log_output(&output),
        };

        let persist_result = tauri::async_runtime::spawn_blocking(move || {
            append_log_and_decrement_remaining_sync(log)
        })
        .await
        .map_err(|e| format!("cron_complete_prompt_run join 失败：{e}"))?;

        match persist_result {
            Ok(settings_changed) => {
                self.finish_prompt_run_completion(
                    &lease.request.execution_id,
                    Some(&lease.request.task_id),
                )?;
                self.handle_task_settings_changed(settings_changed);
                Ok(CronPromptRunCompletionResult {
                    status: CronPromptRunCompletionStatus::Completed,
                })
            }
            Err(error) => {
                self.abort_prompt_run_completion(&lease.request.execution_id)?;
                Err(error)
            }
        }
    }

    async fn run_reload_loop(self: Arc<Self>) {
        if let Err(error) = self.ensure_scheduler().await {
            eprintln!("启动 Cron scheduler 失败：{error}");
            return;
        }

        self.request_reload();

        loop {
            if !self.reload_pending.swap(false, Ordering::SeqCst) {
                self.reload_notify.notified().await;
                continue;
            }

            if let Err(error) = self.reload_from_db().await {
                eprintln!("热重载 Cron 任务失败：{error}");
            }
        }
    }

    async fn ensure_scheduler(&self) -> Result<(), String> {
        let mut guard = self.scheduler.lock().await;
        if guard.is_some() {
            return Ok(());
        }

        let scheduler = JobScheduler::new()
            .await
            .map_err(|e| format!("创建 Cron scheduler 失败：{e}"))?;
        scheduler
            .start()
            .await
            .map_err(|e| format!("启动 Cron scheduler 失败：{e}"))?;
        *guard = Some(scheduler);
        Ok(())
    }

    async fn reload_from_db(self: &Arc<Self>) -> Result<(), String> {
        let snapshot = tauri::async_runtime::spawn_blocking(load_runtime_snapshot_from_db)
            .await
            .map_err(|e| format!("cron reload join 失败：{e}"))??;
        self.replace_jobs(snapshot).await?;
        Ok(())
    }

    async fn replace_jobs(self: &Arc<Self>, snapshot: CronRuntimeSnapshot) -> Result<(), String> {
        self.ensure_scheduler().await?;

        let mut next_jobs = Vec::with_capacity(snapshot.tasks.len());
        for task in snapshot.tasks {
            let workdir = snapshot.workdir.clone();
            let task_id = task.id.clone();
            let runnable_task = task.clone();
            let manager = Arc::clone(self);
            let job = Job::new_async_tz(task.cron.as_str(), Local, move |_job_id, _lock| {
                let manager = Arc::clone(&manager);
                let runnable_task = runnable_task.clone();
                let workdir = workdir.clone();
                Box::pin(async move {
                    manager.spawn_task(runnable_task, workdir);
                })
            })
            .map_err(|e| format!("创建 Cron 任务失败：{task_id} ({e})"))?;
            next_jobs.push((task_id, job));
        }

        let mut scheduler_guard = self.scheduler.lock().await;
        let scheduler = scheduler_guard
            .as_mut()
            .ok_or_else(|| "Cron scheduler 尚未初始化".to_string())?;
        let mut scheduled_jobs = self.scheduled_jobs.lock().await;

        for (_, job_id) in scheduled_jobs.drain() {
            scheduler
                .remove(&job_id)
                .await
                .map_err(|e| format!("移除旧 Cron 任务失败：{e}"))?;
        }

        for (task_id, job) in next_jobs {
            let job_id = job.guid();
            scheduler
                .add(job)
                .await
                .map_err(|e| format!("注册 Cron 任务失败：{task_id} ({e})"))?;
            scheduled_jobs.insert(task_id, job_id);
        }

        Ok(())
    }

    fn queue_prompt_run(
        self: &Arc<Self>,
        task_id: String,
        task: RunnablePromptTask,
    ) -> Result<(), String> {
        if let Some(error) = task.config_error {
            return Err(error);
        }

        let prompt = task.prompt.trim().to_string();
        if prompt.is_empty() {
            return Err("Auto Prompt task has no prompt content.".to_string());
        }

        let provider_id = task.provider_id.trim().to_string();
        if provider_id.is_empty() {
            return Err("Auto Prompt task has no selected provider.".to_string());
        }

        let model = task.model.trim().to_string();
        if model.is_empty() {
            return Err("Auto Prompt task has no selected model.".to_string());
        }

        let request = CronPromptRunRequest {
            execution_id: Uuid::new_v4().to_string(),
            task_id: task_id.clone(),
            task_name: task.task_name.trim().to_string(),
            prompt,
            provider_id,
            model,
            started_at: current_time_ms(),
        };
        let execution_id = request.execution_id.clone();

        let app_handle = {
            let mut state = self
                .prompt_state
                .lock()
                .map_err(|_| "Cron prompt runtime lock poisoned".to_string())?;
            state.active_prompt_runs.insert(
                task_id,
                ActiveCronPromptRun {
                    request: request.clone(),
                },
            );
            state.pending_prompt_runs.insert(
                execution_id.clone(),
                PendingCronPromptRun {
                    request: request.clone(),
                    completion_in_progress: false,
                },
            );
            self.spawn_prompt_watchdog_locked(&mut state, &request);

            state.app_handle.clone()
        };

        if let Some(app_handle) = app_handle {
            if let Err(error) = app_handle.emit(PROMPT_PENDING_EVENT, ()) {
                eprintln!("发送 Cron prompt 事件失败：{error}");
            }
        }

        Ok(())
    }

    fn expire_prompt_run(
        &self,
        execution_id: &str,
    ) -> Result<Option<CronExecutionLogRecord>, String> {
        let request = match self.take_prompt_run_for_expiry(execution_id)? {
            Some(request) => request,
            None => return Ok(None),
        };
        self.emit_prompt_run_expired(&request);

        Ok(Some(CronExecutionLogRecord {
            id: Uuid::new_v4().to_string(),
            task_id: request.task_id,
            started_at: request.started_at,
            success: false,
            duration_ms: elapsed_run_duration_ms(request.started_at),
            exit_code: None,
            output: truncate_log_output(
                "Auto Prompt run timed out before the front-end completed it.",
            ),
        }))
    }

    fn begin_prompt_run_completion(
        &self,
        execution_id: &str,
        expected_task_id: Option<&str>,
    ) -> Result<Option<PromptRunCompletionLease>, String> {
        let execution_id = execution_id.trim();
        if execution_id.is_empty() {
            return Ok(None);
        }

        let request = {
            let mut state = self
                .prompt_state
                .lock()
                .map_err(|_| "Cron prompt runtime lock poisoned".to_string())?;
            let request = match state.active_prompt_runs.values().find_map(|active| {
                if active.request.execution_id == execution_id {
                    Some(active.request.clone())
                } else {
                    None
                }
            }) {
                Some(request) => request,
                None => {
                    state.pending_prompt_runs.remove(execution_id);
                    if let Some(handle) = state.prompt_watchdogs.remove(execution_id) {
                        handle.abort();
                    }
                    return Ok(None);
                }
            };

            if let Some(expected_task_id) = expected_task_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if request.task_id != expected_task_id {
                    return Err(format!(
                        "Cron prompt run task mismatch: expected {expected_task_id}, got {}",
                        request.task_id
                    ));
                }
            }

            let pending = state
                .pending_prompt_runs
                .get_mut(execution_id)
                .ok_or_else(|| "Cron prompt pending run disappeared unexpectedly.".to_string())?;
            if pending.request.task_id != request.task_id {
                return Err("Cron prompt pending run task mismatch.".to_string());
            }
            if pending.completion_in_progress {
                return Err("Cron prompt completion is already in progress.".to_string());
            }
            pending.completion_in_progress = true;
            request
        };

        Ok(Some(PromptRunCompletionLease { request }))
    }

    fn finish_prompt_run_completion(
        &self,
        execution_id: &str,
        expected_task_id: Option<&str>,
    ) -> Result<(), String> {
        let execution_id = execution_id.trim();
        if execution_id.is_empty() {
            return Ok(());
        }

        let (task_id, watchdog) = {
            let mut state = self
                .prompt_state
                .lock()
                .map_err(|_| "Cron prompt runtime lock poisoned".to_string())?;
            let pending = match state.pending_prompt_runs.get(execution_id).cloned() {
                Some(pending) => pending,
                None => {
                    if let Some(handle) = state.prompt_watchdogs.remove(execution_id) {
                        handle.abort();
                    }
                    return Ok(());
                }
            };
            if let Some(expected_task_id) = expected_task_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if pending.request.task_id != expected_task_id {
                    return Err(format!(
                        "Cron prompt run task mismatch: expected {expected_task_id}, got {}",
                        pending.request.task_id
                    ));
                }
            }
            if !pending.completion_in_progress {
                return Err("Cron prompt completion finished without an active lease.".to_string());
            }

            let task_id = pending.request.task_id.clone();
            match state.active_prompt_runs.get(&task_id) {
                Some(active) if active.request.execution_id == execution_id => {}
                Some(active) => {
                    return Err(format!(
                        "Cron prompt active run mismatch: expected {execution_id}, got {}",
                        active.request.execution_id
                    ));
                }
                None => {
                    return Err("Cron prompt active run disappeared unexpectedly.".to_string());
                }
            }

            state.pending_prompt_runs.remove(execution_id);
            state.active_prompt_runs.remove(&task_id);
            let watchdog = state.prompt_watchdogs.remove(execution_id);
            (task_id, watchdog)
        };

        if let Some(watchdog) = watchdog {
            watchdog.abort();
        }
        self.clear_active_task(&task_id);
        Ok(())
    }

    fn abort_prompt_run_completion(self: &Arc<Self>, execution_id: &str) -> Result<(), String> {
        let execution_id = execution_id.trim();
        if execution_id.is_empty() {
            return Ok(());
        }

        let mut state = self
            .prompt_state
            .lock()
            .map_err(|_| "Cron prompt runtime lock poisoned".to_string())?;
        let request = match state.pending_prompt_runs.get_mut(execution_id) {
            Some(pending) => {
                if !pending.completion_in_progress {
                    return Ok(());
                }
                pending.completion_in_progress = false;
                pending.request.clone()
            }
            None => return Ok(()),
        };
        if let Some(watchdog) = state.prompt_watchdogs.remove(execution_id) {
            watchdog.abort();
        }
        self.spawn_prompt_watchdog_locked(&mut state, &request);
        Ok(())
    }

    fn take_prompt_run_for_expiry(
        &self,
        execution_id: &str,
    ) -> Result<Option<CronPromptRunRequest>, String> {
        let execution_id = execution_id.trim();
        if execution_id.is_empty() {
            return Ok(None);
        }

        let request = {
            let mut state = self
                .prompt_state
                .lock()
                .map_err(|_| "Cron prompt runtime lock poisoned".to_string())?;
            let pending = match state.pending_prompt_runs.get(execution_id).cloned() {
                Some(pending) => pending,
                None => {
                    if let Some(handle) = state.prompt_watchdogs.remove(execution_id) {
                        handle.abort();
                    }
                    return Ok(None);
                }
            };

            if pending.completion_in_progress {
                return Ok(None);
            }

            let task_id = pending.request.task_id.clone();
            match state.active_prompt_runs.get(&task_id) {
                Some(active) if active.request.execution_id == execution_id => {}
                Some(_) | None => {
                    state.pending_prompt_runs.remove(execution_id);
                    if let Some(handle) = state.prompt_watchdogs.remove(execution_id) {
                        handle.abort();
                    }
                    return Ok(None);
                }
            }

            state.pending_prompt_runs.remove(execution_id);
            state.active_prompt_runs.remove(&task_id);
            state.prompt_watchdogs.remove(execution_id);
            pending.request
        };

        self.clear_active_task(&request.task_id);
        Ok(Some(request))
    }

    fn spawn_prompt_watchdog_locked(
        self: &Arc<Self>,
        state: &mut CronPromptRuntimeState,
        request: &CronPromptRunRequest,
    ) {
        let delay_ms = remaining_prompt_run_timeout_ms(request.started_at);
        let execution_id = request.execution_id.clone();
        let manager = Arc::clone(self);
        let execution_id_for_watchdog = execution_id.clone();
        let watchdog = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let maybe_log = manager.expire_prompt_run(&execution_id_for_watchdog);
            match maybe_log {
                Ok(Some(log)) => {
                    match tauri::async_runtime::spawn_blocking(move || {
                        append_log_and_decrement_remaining_sync(log)
                    })
                    .await
                    {
                        Ok(Ok(settings_changed)) => {
                            manager.handle_task_settings_changed(settings_changed);
                        }
                        Ok(Err(error)) => {
                            eprintln!("Cron prompt watchdog log persist failed: {error}");
                        }
                        Err(error) => {
                            eprintln!("Cron prompt watchdog log persist join failed: {error}");
                        }
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("Cron prompt watchdog failed: {error}"),
            }
        });
        if let Some(previous) = state.prompt_watchdogs.insert(execution_id, watchdog) {
            previous.abort();
        }
    }

    fn emit_prompt_run_expired(&self, request: &CronPromptRunRequest) {
        let app_handle = match self.prompt_state.lock() {
            Ok(state) => state.app_handle.clone(),
            Err(_) => None,
        };
        if let Some(app_handle) = app_handle {
            if let Err(error) = app_handle.emit(
                PROMPT_EXPIRED_EVENT,
                CronPromptRunExpiredEvent {
                    execution_id: request.execution_id.clone(),
                    task_id: request.task_id.clone(),
                },
            ) {
                eprintln!("发送 Cron prompt timeout 事件失败：{error}");
            }
        }
    }

    fn clear_active_task(&self, task_id: &str) {
        if let Ok(mut active) = self.active_runs.lock() {
            active.remove(task_id);
        }
    }

    fn spawn_task(self: &Arc<Self>, task: RunnableCronTask, workdir: String) {
        {
            let mut active = match self.active_runs.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            if !active.insert(task.id.clone()) {
                let skipped_log = build_skipped_log(
                    task.id.clone(),
                    "Skipped: previous run is still in progress.".to_string(),
                );
                tauri::async_runtime::spawn(async move {
                    let _ =
                        tauri::async_runtime::spawn_blocking(move || append_log_sync(skipped_log))
                            .await;
                });
                return;
            }
        }

        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let task_id = task.id.clone();
            let can_run = tauri::async_runtime::spawn_blocking({
                let task_id = task_id.clone();
                move || task_can_run_now_sync(&task_id)
            })
            .await;
            match can_run {
                Ok(Ok(true)) => {}
                Ok(Ok(false)) => {
                    manager.clear_active_task(&task_id);
                    manager.request_reload();
                    return;
                }
                Ok(Err(error)) => {
                    let log = build_failed_log(
                        task_id.clone(),
                        format!("Cron task state check failed: {error}"),
                        None,
                    );
                    let _ =
                        tauri::async_runtime::spawn_blocking(move || append_log_sync(log)).await;
                    manager.clear_active_task(&task_id);
                    return;
                }
                Err(error) => {
                    let log = build_failed_log(
                        task_id.clone(),
                        format!("Cron task state check join failed: {error}"),
                        None,
                    );
                    let _ =
                        tauri::async_runtime::spawn_blocking(move || append_log_sync(log)).await;
                    manager.clear_active_task(&task_id);
                    return;
                }
            }

            let prompt_task = match task.kind.clone() {
                RunnableCronKind::Prompt { task } => Some(task),
                _ => None,
            };
            if let Some(prompt_task) = prompt_task {
                if let Err(error) = manager.queue_prompt_run(task_id.clone(), prompt_task) {
                    let log = build_failed_log(task_id.clone(), error, None);
                    match tauri::async_runtime::spawn_blocking(move || {
                        append_log_and_decrement_remaining_sync(log)
                    })
                    .await
                    {
                        Ok(Ok(settings_changed)) => {
                            manager.handle_task_settings_changed(settings_changed);
                        }
                        Ok(Err(error)) => {
                            eprintln!("Cron prompt config error log persist failed: {error}");
                        }
                        Err(error) => {
                            eprintln!("Cron prompt config error log persist join failed: {error}");
                        }
                    }
                    manager.clear_active_task(&task_id);
                }
                return;
            }

            let execution =
                tauri::async_runtime::spawn_blocking(move || execute_task_sync(task, workdir))
                    .await;

            let log = match execution {
                Ok(log) => log,
                Err(error) => build_failed_log(
                    task_id.clone(),
                    format!("Cron task execution join failed: {error}"),
                    None,
                ),
            };

            match tauri::async_runtime::spawn_blocking(move || {
                append_log_and_decrement_remaining_sync(log)
            })
            .await
            {
                Ok(Ok(settings_changed)) => {
                    manager.handle_task_settings_changed(settings_changed);
                }
                Ok(Err(error)) => {
                    eprintln!("Cron task log persist failed: {error}");
                }
                Err(error) => {
                    eprintln!("Cron task log persist join failed: {error}");
                }
            }

            manager.clear_active_task(&task_id);
        });
    }
}

pub(crate) fn validate_cron_expression(expression: &str) -> Result<(), String> {
    let trimmed = expression.trim();
    if trimmed.is_empty() {
        return Err("Cron 表达式不能为空".to_string());
    }
    if trimmed.split_whitespace().count() != 6 {
        return Err("Cron 表达式必须是标准六段格式（秒 分 时 日 月 周）".to_string());
    }
    parse_scheduler_expression(trimmed)?;
    Ok(())
}

fn parse_scheduler_expression(expression: &str) -> Result<(), String> {
    Job::new_async_tz(expression, Local, |_job_id, _lock| Box::pin(async move {}))
        .map(|_| ())
        .map_err(|e| format!("无效 Cron 表达式：{expression} ({e})"))
}

pub(crate) fn list_logs_sync(
    task_id: String,
    limit: usize,
) -> Result<Vec<CronExecutionLogRecord>, String> {
    let conn = open_db()?;
    list_logs_for_task(&conn, &task_id, limit)
}

pub(crate) fn list_logs_for_task(
    conn: &Connection,
    task_id: &str,
    limit: usize,
) -> Result<Vec<CronExecutionLogRecord>, String> {
    let limit = limit.clamp(1, 500) as i64;
    let mut stmt = conn
        .prepare(&format!(
            "
            SELECT log_id, task_id, started_at, success, duration_ms, exit_code, output
            FROM {CRON_LOGS_TABLE}
            WHERE task_id = ?1
            ORDER BY started_at DESC, log_id DESC
            LIMIT ?2
            "
        ))
        .map_err(|e| format!("准备读取 {CRON_LOGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map(params![task_id, limit], |row| {
            Ok(CronExecutionLogRecord {
                id: row.get::<_, String>(0)?,
                task_id: row.get::<_, String>(1)?,
                started_at: row.get::<_, i64>(2)?,
                success: row.get::<_, i64>(3)? != 0,
                duration_ms: row.get::<_, i64>(4)? as u128,
                exit_code: row.get::<_, Option<i32>>(5)?,
                output: row.get::<_, String>(6)?,
            })
        })
        .map_err(|e| format!("读取 {CRON_LOGS_TABLE} 失败：{e}"))?;

    let mut logs = Vec::new();
    for row in rows {
        logs.push(row.map_err(|e| format!("读取 {CRON_LOGS_TABLE} 行失败：{e}"))?);
    }
    Ok(logs)
}

pub(crate) fn clear_logs_sync(task_id: String) -> Result<usize, String> {
    let conn = open_db()?;
    clear_logs_for_task(&conn, &task_id)
}

pub(crate) fn append_log_sync(log: CronExecutionLogRecord) -> Result<(), String> {
    append_log_with_remaining_update_sync(log, false).map(|_| ())
}

fn append_log_and_decrement_remaining_sync(log: CronExecutionLogRecord) -> Result<bool, String> {
    append_log_with_remaining_update_sync(log, true)
}

fn append_log_with_remaining_update_sync(
    log: CronExecutionLogRecord,
    decrement_remaining: bool,
) -> Result<bool, String> {
    let mut conn = open_db()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {CRON_LOGS_TABLE} 事务失败：{e}"))?;
    let task_id = log.task_id.clone();
    tx.execute(
        &format!(
            "
            INSERT INTO {CRON_LOGS_TABLE}
                (log_id, task_id, started_at, success, duration_ms, exit_code, output)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "
        ),
        params![
            log.id,
            log.task_id,
            log.started_at,
            if log.success { 1_i64 } else { 0_i64 },
            log.duration_ms as i64,
            log.exit_code,
            log.output,
        ],
    )
    .map_err(|e| format!("写入 {CRON_LOGS_TABLE} 失败：{e}"))?;
    let settings_changed = if decrement_remaining {
        decrement_remaining_executions_in_tx(&tx, &task_id)?
    } else {
        false
    };
    tx.commit()
        .map_err(|e| format!("提交 {CRON_LOGS_TABLE} 事务失败：{e}"))?;
    Ok(settings_changed)
}

fn decrement_remaining_executions_in_tx(
    tx: &Transaction<'_>,
    task_id: &str,
) -> Result<bool, String> {
    let raw = tx
        .query_row(
            &format!("SELECT payload_json FROM {CRON_SETTINGS_TABLE} WHERE task_id = ?1 LIMIT 1"),
            params![task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {CRON_SETTINGS_TABLE}.{task_id} 失败：{e}"))?;
    let Some(raw) = raw else {
        return Ok(false);
    };

    let mut payload = serde_json::from_str::<Value>(&raw)
        .map_err(|e| format!("解析 {CRON_SETTINGS_TABLE}.{task_id} JSON 失败：{e}"))?;
    let Some(object) = payload.as_object_mut() else {
        return Ok(false);
    };
    let Some(remaining) = object.get("remainingExecutions").and_then(Value::as_u64) else {
        return Ok(false);
    };

    if remaining == 0 {
        if object.get("enabled").and_then(Value::as_bool) == Some(true) {
            object.insert("enabled".to_string(), Value::Bool(false));
        } else {
            return Ok(false);
        }
    } else {
        let next_remaining = remaining.saturating_sub(1);
        object.insert(
            "remainingExecutions".to_string(),
            Value::Number(next_remaining.into()),
        );
        if next_remaining == 0 {
            object.insert("enabled".to_string(), Value::Bool(false));
        }
    }

    let payload_json = serde_json::to_string(&payload)
        .map_err(|e| format!("序列化 {CRON_SETTINGS_TABLE}.{task_id} 失败：{e}"))?;
    tx.execute(
        &format!(
            "UPDATE {CRON_SETTINGS_TABLE} SET payload_json = ?1, updated_at = ?2 WHERE task_id = ?3"
        ),
        params![payload_json, current_time_ms(), task_id],
    )
    .map_err(|e| format!("更新 {CRON_SETTINGS_TABLE}.{task_id} 执行轮次失败：{e}"))?;
    Ok(true)
}

fn clear_logs_for_task(conn: &Connection, task_id: &str) -> Result<usize, String> {
    conn.execute(
        &format!("DELETE FROM {CRON_LOGS_TABLE} WHERE task_id = ?1"),
        params![task_id],
    )
    .map_err(|e| format!("清理 {CRON_LOGS_TABLE} 失败：{e}"))
}

fn load_runtime_snapshot_from_db() -> Result<CronRuntimeSnapshot, String> {
    let conn = open_db()?;
    let workdir = load_system_workdir(&conn)?;
    let tasks = load_runnable_tasks(&conn)?;
    Ok(CronRuntimeSnapshot { workdir, tasks })
}

fn task_can_run_now_sync(task_id: &str) -> Result<bool, String> {
    let conn = open_db()?;
    let raw = conn
        .query_row(
            &format!("SELECT payload_json FROM {CRON_SETTINGS_TABLE} WHERE task_id = ?1 LIMIT 1"),
            params![task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {CRON_SETTINGS_TABLE}.{task_id} 失败：{e}"))?;
    let Some(raw) = raw else {
        return Ok(false);
    };
    let payload = serde_json::from_str::<Value>(&raw)
        .map_err(|e| format!("解析 {CRON_SETTINGS_TABLE}.{task_id} JSON 失败：{e}"))?;
    let Some(object) = payload.as_object() else {
        return Ok(false);
    };
    if object.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Ok(false);
    }
    if object.get("remainingExecutions").and_then(Value::as_u64) == Some(0) {
        return Ok(false);
    }
    Ok(true)
}

fn load_system_workdir(conn: &Connection) -> Result<String, String> {
    let raw = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {SYSTEM_SETTINGS_TABLE} WHERE setting_key = ?1 LIMIT 1"
            ),
            params![SYSTEM_WORKDIR_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {SYSTEM_SETTINGS_TABLE}.{SYSTEM_WORKDIR_KEY} 失败：{e}"))?;

    let Some(raw) = raw else {
        return Ok(String::new());
    };

    match serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("解析 {SYSTEM_SETTINGS_TABLE}.{SYSTEM_WORKDIR_KEY} 失败：{e}"))?
    {
        serde_json::Value::String(value) => Ok(value.trim().to_string()),
        serde_json::Value::Null => Ok(String::new()),
        _ => Err(format!(
            "{SYSTEM_SETTINGS_TABLE}.{SYSTEM_WORKDIR_KEY} 必须是字符串"
        )),
    }
}

fn load_runnable_tasks(conn: &Connection) -> Result<Vec<RunnableCronTask>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "
            SELECT task_id, payload_json
            FROM {CRON_SETTINGS_TABLE}
            ORDER BY sort_index ASC, task_id ASC
            "
        ))
        .map_err(|e| format!("准备读取 {CRON_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 失败：{e}"))?;

    let mut tasks = Vec::new();
    for row in rows {
        let (task_id, payload_json) =
            row.map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 行失败：{e}"))?;
        let payload = serde_json::from_str::<StoredCronTaskPayload>(&payload_json)
            .map_err(|e| format!("解析 {CRON_SETTINGS_TABLE} JSON 失败：{e}"))?;
        let _ = &payload.description;
        if !payload.enabled {
            continue;
        }
        if stored_remaining_executions(payload.remaining_executions.as_ref()) == Some(0) {
            continue;
        }

        let kind = match payload.task_type.as_str() {
            "bash" => {
                let script = payload.script.trim().to_string();
                if script.is_empty() {
                    return Err(format!("Cron task {task_id} 缺少 script"));
                }
                RunnableCronKind::Bash { script }
            }
            "http" => RunnableCronKind::Http {
                requests: payload.requests,
            },
            "prompt" => RunnableCronKind::Prompt {
                task: build_runnable_prompt_task(&payload),
            },
            _ => continue,
        };

        tasks.push(RunnableCronTask {
            id: task_id,
            cron: payload.cron.trim().to_string(),
            kind,
        });
    }

    Ok(tasks)
}

fn stored_remaining_executions(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(number)) => number.as_u64(),
        Some(Value::String(text)) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn build_runnable_prompt_task(payload: &StoredCronTaskPayload) -> RunnablePromptTask {
    let task_name = payload.name.trim().to_string();
    let prompt = payload.prompt.trim().to_string();

    let Some(selected_model) = payload.selected_model.as_ref() else {
        return RunnablePromptTask {
            task_name,
            provider_id: String::new(),
            model: String::new(),
            prompt,
            config_error: Some(
                "Auto Prompt task is missing the selected model configuration.".to_string(),
            ),
        };
    };

    let provider_id = selected_model.custom_provider_id.trim().to_string();
    let model = selected_model.model.trim().to_string();
    let config_error = if provider_id.is_empty() || model.is_empty() {
        Some("Auto Prompt task has an invalid selected model configuration.".to_string())
    } else {
        None
    };

    RunnablePromptTask {
        task_name,
        provider_id,
        model,
        prompt,
        config_error,
    }
}

fn execute_task_sync(task: RunnableCronTask, workdir: String) -> CronExecutionLogRecord {
    match task.kind {
        RunnableCronKind::Bash { script } => execute_bash_task(task.id, script, workdir),
        RunnableCronKind::Http { requests } => execute_http_task(task.id, requests),
        RunnableCronKind::Prompt { .. } => build_failed_log(
            task.id,
            "Prompt cron tasks must be executed by the front-end runner.".to_string(),
            None,
        ),
    }
}

fn execute_bash_task(task_id: String, script: String, workdir: String) -> CronExecutionLogRecord {
    let started_at = current_time_ms();
    let overall_start = Instant::now();

    let script = script.trim().to_string();
    if script.is_empty() {
        return build_failed_log(
            task_id,
            "No Bash script configured for this Cron task.".to_string(),
            None,
        );
    }

    let cwd = match resolve_workdir(Some(workdir)) {
        Ok(cwd) => cwd,
        Err(error) => return build_failed_log(task_id, error, None),
    };

    let result = match run_shell_script(
        cwd.display().to_string(),
        script.clone(),
        None,
        Some(DEFAULT_CRON_SCRIPT_TIMEOUT_MS),
        None,
        None,
        None,
    ) {
        Ok(result) => result,
        Err(error) => return build_failed_log(task_id, error, None),
    };
    let success = result.exit_code == 0 && !result.timed_out;
    let exit_code = Some(result.exit_code);
    let output = format_shell_script_result(&script, &result);

    CronExecutionLogRecord {
        id: Uuid::new_v4().to_string(),
        task_id,
        started_at,
        success,
        duration_ms: overall_start.elapsed().as_millis(),
        exit_code,
        output: truncate_log_output(&output),
    }
}

fn execute_http_task(task_id: String, requests: Vec<HttpRequestInput>) -> CronExecutionLogRecord {
    let started_at = current_time_ms();
    let overall_start = Instant::now();

    if requests.is_empty() {
        return build_failed_log(
            task_id,
            "No HTTP requests configured for this Cron task.".to_string(),
            None,
        );
    }

    let client = match build_http_client() {
        Ok(client) => client,
        Err(error) => return build_failed_log(task_id, error, None),
    };

    let mut sections = Vec::new();

    for (index, request) in requests.into_iter().enumerate() {
        let display = format!(
            "{} {}",
            request.method.trim().to_uppercase(),
            request.url.trim()
        );
        match run_single_http_request(&client, request) {
            Ok(result) => sections.push(format_http_result(index + 1, &display, &result)),
            Err(error) => {
                sections.push(format_http_failure(index + 1, &display, &error));
                return CronExecutionLogRecord {
                    id: Uuid::new_v4().to_string(),
                    task_id,
                    started_at,
                    success: false,
                    duration_ms: overall_start.elapsed().as_millis(),
                    exit_code: None,
                    output: truncate_log_output(&sections.join("\n\n")),
                };
            }
        }
    }

    CronExecutionLogRecord {
        id: Uuid::new_v4().to_string(),
        task_id,
        started_at,
        success: true,
        duration_ms: overall_start.elapsed().as_millis(),
        exit_code: None,
        output: truncate_log_output(&sections.join("\n\n")),
    }
}

fn elapsed_run_duration_ms(started_at: i64) -> u128 {
    let now = current_time_ms();
    if now <= started_at {
        0
    } else {
        (now - started_at) as u128
    }
}

fn normalize_run_duration_ms(started_at: i64, reported_duration_ms: u64) -> u128 {
    if reported_duration_ms > 0 {
        reported_duration_ms as u128
    } else {
        elapsed_run_duration_ms(started_at)
    }
}

fn remaining_prompt_run_timeout_ms(started_at: i64) -> u64 {
    let elapsed = elapsed_run_duration_ms(started_at);
    if elapsed >= PROMPT_RUN_TIMEOUT_MS as u128 {
        1
    } else {
        PROMPT_RUN_TIMEOUT_MS - elapsed as u64
    }
}

fn build_skipped_log(task_id: String, reason: String) -> CronExecutionLogRecord {
    CronExecutionLogRecord {
        id: Uuid::new_v4().to_string(),
        task_id,
        started_at: current_time_ms(),
        success: false,
        duration_ms: 0,
        exit_code: None,
        output: truncate_log_output(&reason),
    }
}

fn build_failed_log(
    task_id: String,
    message: String,
    exit_code: Option<i32>,
) -> CronExecutionLogRecord {
    CronExecutionLogRecord {
        id: Uuid::new_v4().to_string(),
        task_id,
        started_at: current_time_ms(),
        success: false,
        duration_ms: 0,
        exit_code,
        output: truncate_log_output(&message),
    }
}

fn current_time_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn truncate_log_output(text: &str) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for ch in text.chars() {
        if count >= MAX_LOG_OUTPUT_CHARS {
            out.push_str("\n...[log truncated]");
            break;
        }
        out.push(ch);
        count += 1;
    }
    out
}

fn format_shell_script_result(script: &str, result: &ShellRunResponse) -> String {
    let mut lines = vec![
        format!("shell={}", result.shell),
        format!("exit={}", result.exit_code),
        format!("timed_out={}", result.timed_out),
        format!("duration={}ms", result.duration_ms),
        "script:".to_string(),
        script.to_string(),
    ];
    if !result.stdout.trim().is_empty() {
        lines.push("stdout:".to_string());
        lines.push(result.stdout.trim().to_string());
    }
    if !result.stderr.trim().is_empty() {
        lines.push("stderr:".to_string());
        lines.push(result.stderr.trim().to_string());
    }
    if result.stdout_truncated {
        lines.push("stdout_truncated=true".to_string());
    }
    if result.stderr_truncated {
        lines.push("stderr_truncated=true".to_string());
    }
    lines.join("\n")
}

fn format_http_result(index: usize, display: &str, result: &HttpExecutionResult) -> String {
    let mut lines = vec![
        format!("Request {index}: {display}"),
        format!("status={}", result.status),
        format!("duration={}ms", result.duration_ms),
    ];
    if !result.response_body.trim().is_empty() {
        lines.push("response:".to_string());
        lines.push(result.response_body.trim().to_string());
    }
    lines.join("\n")
}

fn format_http_failure(index: usize, display: &str, error: &HttpExecutionFailure) -> String {
    vec![
        format!("Request {index}: {display}"),
        "status=failed".to_string(),
        format!("duration={}ms", error.duration_ms),
        error.to_string(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn seed_prompt_run(manager: &CronManager, request: CronPromptRunRequest) {
        manager
            .active_runs
            .lock()
            .expect("lock active runs")
            .insert(request.task_id.clone());
        let mut prompt_state = manager.prompt_state.lock().expect("lock prompt state");
        prompt_state.pending_prompt_runs.insert(
            request.execution_id.clone(),
            PendingCronPromptRun {
                request: request.clone(),
                completion_in_progress: false,
            },
        );
        prompt_state
            .active_prompt_runs
            .insert(request.task_id.clone(), ActiveCronPromptRun { request });
    }

    #[test]
    fn validate_cron_expression_accepts_six_field_syntax() {
        validate_cron_expression("0 * * * * *").expect("validate six-field cron");
    }

    #[test]
    fn validate_cron_expression_rejects_legacy_five_field_syntax() {
        let error = validate_cron_expression("* * * * *").expect_err("reject five-field cron");
        assert!(error.contains("标准六段格式"));
    }

    #[test]
    fn load_runnable_tasks_rejects_bash_without_script() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "
            CREATE TABLE cron_settings (
                task_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                sort_index INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            ",
        )
        .expect("create cron_settings");
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at)
             VALUES ('legacy-bash', ?1, 0, 1)",
            [r#"{"name":"Legacy","cron":"0 * * * * *","enabled":true,"type":"bash","commands":[["echo","legacy"]]}"#],
        )
        .expect("insert legacy bash task");

        let error = load_runnable_tasks(&conn).expect_err("reject bash task without script");
        assert!(error.contains("legacy-bash"));
        assert!(error.contains("script"));
    }

    #[test]
    fn load_runnable_tasks_skips_exhausted_tasks() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "
            CREATE TABLE cron_settings (
                task_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                sort_index INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            ",
        )
        .expect("create cron_settings");
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at)
             VALUES ('exhausted', ?1, 0, 1)",
            [r#"{"name":"Exhausted","cron":"0 * * * * *","enabled":true,"remainingExecutions":0,"type":"bash","script":"echo exhausted"}"#],
        )
        .expect("insert exhausted task");
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at)
             VALUES ('finite', ?1, 1, 1)",
            [r#"{"name":"Finite","cron":"0 * * * * *","enabled":true,"remainingExecutions":1,"type":"bash","script":"echo finite"}"#],
        )
        .expect("insert finite task");

        let tasks = load_runnable_tasks(&conn).expect("load runnable tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "finite");
    }

    #[test]
    fn decrement_remaining_executions_disables_task_at_zero() {
        let mut conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "
            CREATE TABLE cron_settings (
                task_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                sort_index INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            ",
        )
        .expect("create cron_settings");
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at)
             VALUES ('finite', ?1, 0, 1)",
            [r#"{"name":"Finite","cron":"0 * * * * *","enabled":true,"remainingExecutions":1,"type":"bash","script":"echo finite"}"#],
        )
        .expect("insert finite task");

        let tx = conn.transaction().expect("open transaction");
        let changed =
            decrement_remaining_executions_in_tx(&tx, "finite").expect("decrement remaining");
        tx.commit().expect("commit decrement");

        assert!(changed);
        let payload_json = conn
            .query_row(
                "SELECT payload_json FROM cron_settings WHERE task_id = 'finite'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("load finite task");
        let payload = serde_json::from_str::<Value>(&payload_json).expect("parse payload");
        assert_eq!(payload["remainingExecutions"], Value::from(0));
        assert_eq!(payload["enabled"], Value::from(false));
    }

    #[test]
    fn clear_logs_for_task_deletes_only_target_rows() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "
            CREATE TABLE cron_execution_logs (
                log_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                success INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL,
                exit_code INTEGER,
                output TEXT NOT NULL DEFAULT ''
            );
            ",
        )
        .expect("create cron_execution_logs");
        conn.execute(
            "INSERT INTO cron_execution_logs (log_id, task_id, started_at, success, duration_ms, exit_code, output)
             VALUES ('log-1', 'task-a', 1, 1, 10, 0, 'ok')",
            [],
        )
        .expect("insert task-a log");
        conn.execute(
            "INSERT INTO cron_execution_logs (log_id, task_id, started_at, success, duration_ms, exit_code, output)
             VALUES ('log-2', 'task-b', 2, 0, 20, NULL, 'fail')",
            [],
        )
        .expect("insert task-b log");

        let deleted = clear_logs_for_task(&conn, "task-a").expect("clear task-a logs");
        let task_a_count = conn
            .query_row(
                "SELECT COUNT(*) FROM cron_execution_logs WHERE task_id = 'task-a'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count task-a rows");
        let task_b_count = conn
            .query_row(
                "SELECT COUNT(*) FROM cron_execution_logs WHERE task_id = 'task-b'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count task-b rows");

        assert_eq!(deleted, 1);
        assert_eq!(task_a_count, 0);
        assert_eq!(task_b_count, 1);
    }

    #[test]
    fn queue_prompt_run_enqueues_frontend_request() {
        let manager = Arc::new(CronManager::new());
        manager
            .queue_prompt_run(
                "task-a".to_string(),
                RunnablePromptTask {
                    task_name: "Daily summary".to_string(),
                    provider_id: "provider-a".to_string(),
                    model: "gpt-5".to_string(),
                    prompt: "Summarize the repo state".to_string(),
                    config_error: None,
                },
            )
            .expect("queue prompt run");

        let runs = manager
            .take_pending_prompt_runs()
            .expect("take pending prompt runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].task_id, "task-a");
        assert_eq!(runs[0].task_name, "Daily summary");
        assert_eq!(runs[0].provider_id, "provider-a");
        assert_eq!(runs[0].model, "gpt-5");
        assert_eq!(runs[0].prompt, "Summarize the repo state");

        let second_take = manager
            .take_pending_prompt_runs()
            .expect("take pending prompt runs again");
        assert_eq!(second_take, runs);

        let timeout_log = manager
            .expire_prompt_run(&runs[0].execution_id)
            .expect("expire queued prompt run")
            .expect("timeout log");
        assert_eq!(timeout_log.task_id, "task-a");
        assert!(!timeout_log.success);
    }

    #[test]
    fn begin_and_abort_prompt_completion_restores_pending_visibility() {
        let manager = Arc::new(CronManager::new());
        let request = CronPromptRunRequest {
            execution_id: "exec-1".to_string(),
            task_id: "task-a".to_string(),
            task_name: "Daily summary".to_string(),
            prompt: "Summarize".to_string(),
            provider_id: "provider-a".to_string(),
            model: "gpt-5".to_string(),
            started_at: current_time_ms() - 250,
        };
        seed_prompt_run(manager.as_ref(), request.clone());

        let lease = manager
            .begin_prompt_run_completion("exec-1", Some("task-a"))
            .expect("begin completion")
            .expect("completion lease");
        assert_eq!(lease.request.execution_id, "exec-1");
        assert!(
            manager
                .take_pending_prompt_runs()
                .expect("pending snapshot while completing")
                .is_empty()
        );

        manager
            .abort_prompt_run_completion("exec-1")
            .expect("abort completion");
        let runs = manager
            .take_pending_prompt_runs()
            .expect("pending snapshot after abort");
        assert_eq!(runs, vec![request]);
        assert!(
            manager
                .prompt_state
                .lock()
                .expect("lock prompt state")
                .active_prompt_runs
                .contains_key("task-a")
        );
    }

    #[test]
    fn finish_prompt_run_completion_clears_runtime() {
        let manager = Arc::new(CronManager::new());
        let request = CronPromptRunRequest {
            execution_id: "exec-1".to_string(),
            task_id: "task-a".to_string(),
            task_name: "Daily summary".to_string(),
            prompt: "Summarize".to_string(),
            provider_id: "provider-a".to_string(),
            model: "gpt-5".to_string(),
            started_at: current_time_ms() - 250,
        };
        seed_prompt_run(manager.as_ref(), request);

        manager
            .begin_prompt_run_completion("exec-1", Some("task-a"))
            .expect("begin completion")
            .expect("completion lease");
        manager
            .finish_prompt_run_completion("exec-1", Some("task-a"))
            .expect("finish completion");

        assert!(
            manager
                .prompt_state
                .lock()
                .expect("lock prompt state")
                .active_prompt_runs
                .is_empty()
        );
        assert!(
            manager
                .prompt_state
                .lock()
                .expect("lock prompt state")
                .pending_prompt_runs
                .is_empty()
        );
        assert!(
            manager
                .active_runs
                .lock()
                .expect("lock active runs")
                .is_empty()
        );
    }

    #[test]
    fn expire_prompt_run_returns_failure_and_clears_runtime() {
        let manager = Arc::new(CronManager::new());
        let request = CronPromptRunRequest {
            execution_id: "exec-timeout".to_string(),
            task_id: "task-timeout".to_string(),
            task_name: "Timeout".to_string(),
            prompt: "Wait".to_string(),
            provider_id: "provider-a".to_string(),
            model: "gpt-5".to_string(),
            started_at: current_time_ms() - 500,
        };
        seed_prompt_run(manager.as_ref(), request);

        let log = manager
            .expire_prompt_run("exec-timeout")
            .expect("expire prompt run")
            .expect("timeout log");

        assert_eq!(log.task_id, "task-timeout");
        assert!(!log.success);
        assert!(log.output.contains("timed out"));
        assert!(
            manager
                .prompt_state
                .lock()
                .expect("lock prompt state")
                .active_prompt_runs
                .is_empty()
        );
    }

    #[tokio::test]
    async fn complete_prompt_run_returns_already_finished_for_missing_execution() {
        let manager = Arc::new(CronManager::new());

        let result = manager
            .complete_prompt_run(CronCompletePromptRunInput {
                execution_id: "missing-exec".to_string(),
                task_id: "task-a".to_string(),
                success: true,
                duration_ms: 123,
                output: "late conclusion".to_string(),
            })
            .await
            .expect("complete prompt run");

        assert_eq!(
            result.status,
            CronPromptRunCompletionStatus::AlreadyFinished
        );
        assert!(
            manager
                .prompt_state
                .lock()
                .expect("lock prompt state")
                .pending_prompt_runs
                .is_empty()
        );
        assert!(
            manager
                .prompt_state
                .lock()
                .expect("lock prompt state")
                .active_prompt_runs
                .is_empty()
        );
    }
}
