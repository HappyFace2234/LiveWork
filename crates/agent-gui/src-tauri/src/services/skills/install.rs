//! 安装编排：备份、带冲突策略的复制与 install payload 处理。

use chrono::Utc;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::*;

pub(crate) fn backup_existing_path(
    dest_root: &Path,
    target: &Path,
    skill_name: &str,
) -> Result<PathBuf, String> {
    let backups_root = dest_root.join(".backups");
    fs::create_dir_all(&backups_root)
        .map_err(|e| format!("Failed to create Skills backup directory: {e}"))?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let mut backup = backups_root.join(format!("{skill_name}-{stamp}"));
    let mut counter = 1usize;
    while backup.exists() {
        backup = backups_root.join(format!("{skill_name}-{stamp}-{counter}"));
        counter += 1;
    }
    fs::rename(target, &backup).map_err(|e| {
        format!(
            "Failed to move existing Skill to backup {}: {e}",
            backup.display()
        )
    })?;
    Ok(backup)
}

pub(crate) fn copy_dir_safely(source_dir: &Path, target: &Path) -> Result<(), String> {
    for entry in WalkDir::new(source_dir).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|e| format!("Failed to inspect source Skill: {e}"))?;
        let source_path = entry.path();
        let rel = source_path
            .strip_prefix(source_dir)
            .map_err(|e| format!("Failed to compute relative Skill path: {e}"))?;
        let target_path = target.join(rel);
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            return Err(format!(
                "Skill source contains a symlink, which is not supported: {}",
                source_path.display()
            ));
        }
        if file_type.is_dir() {
            fs::create_dir_all(&target_path)
                .map_err(|e| format!("Failed to create Skill directory: {e}"))?;
            continue;
        }
        if file_type.is_file() {
            let size = entry
                .metadata()
                .map_err(|e| format!("Failed to read source Skill file metadata: {e}"))?
                .len();
            if size > MAX_SKILL_FILE_BYTES {
                return Err(format!(
                    "Skill file is too large: {} ({} bytes)",
                    source_path.display(),
                    size
                ));
            }
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create Skill parent directory: {e}"))?;
            }
            fs::copy(source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy Skill file {} to {}: {e}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

pub(crate) fn copy_skill_with_conflict(
    source_dir: &Path,
    dest_root: &Path,
    skill_name: &str,
    conflict: &str,
) -> Result<SystemSkillInstallResult, String> {
    let skill_name = sanitize_skill_name(skill_name)?;
    fs::create_dir_all(dest_root)
        .map_err(|e| format!("Failed to create Skills root directory: {e}"))?;
    let target = dest_root.join(&skill_name);
    let mut backup = None;

    if target.exists() {
        if source_dir.canonicalize().ok() == target.canonicalize().ok() {
            let metadata = read_skill_metadata_from_dir(&target)?;
            return Ok(SystemSkillInstallResult {
                name: skill_name,
                target: display_path(&target),
                backup: None,
                skill_file: rel_to_root_str(dest_root, &metadata.metadata_file),
            });
        }

        match conflict {
            "fail" => return Err(format!("Destination already exists: {}", target.display())),
            "overwrite" => {
                let meta = fs::symlink_metadata(&target)
                    .map_err(|e| format!("Failed to inspect destination: {e}"))?;
                if meta.is_dir() {
                    fs::remove_dir_all(&target).map_err(|e| {
                        format!("Failed to remove existing Skill {}: {e}", target.display())
                    })?;
                } else {
                    fs::remove_file(&target).map_err(|e| {
                        format!("Failed to remove existing Skill {}: {e}", target.display())
                    })?;
                }
            }
            "backup" => {
                backup = Some(backup_existing_path(dest_root, &target, &skill_name)?);
            }
            other => return Err(format!("Unsupported conflict mode: {other}")),
        }
    }

    fs::create_dir_all(&target)
        .map_err(|e| format!("Failed to create target Skill directory: {e}"))?;
    copy_dir_safely(source_dir, &target)?;
    let metadata = read_skill_metadata_from_dir(&target)?;
    if metadata.name != skill_name {
        return Err(format!(
            "Installed Skill metadata name '{}' does not match target directory '{}'",
            metadata.name, skill_name
        ));
    }

    Ok(SystemSkillInstallResult {
        name: skill_name,
        target: display_path(&target),
        backup: backup.map(|path| display_path(&path)),
        skill_file: rel_to_root_str(dest_root, &metadata.metadata_file),
    })
}

pub(crate) fn normalize_conflict(value: Option<&str>, default_value: &str) -> Result<String, String> {
    let raw = value.unwrap_or(default_value).trim();
    match raw {
        "backup" | "fail" | "overwrite" => Ok(raw.to_string()),
        _ => Err(format!("Unsupported conflict mode: {raw}")),
    }
}

pub(crate) fn normalize_method(value: Option<&str>) -> Result<String, String> {
    let raw = value.unwrap_or("auto").trim();
    match raw {
        "auto" | "download" | "git" => Ok(raw.to_string()),
        _ => Err(format!("Unsupported GitHub method: {raw}")),
    }
}

pub(crate) fn install_source_from_payload(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
) -> Result<Vec<SystemSkillInstallResult>, String> {
    install_source_from_payload_with_progress(root, payload, |_| {})
}

pub(crate) fn install_source_from_payload_with_progress<F>(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
    mut on_progress: F,
) -> Result<Vec<SystemSkillInstallResult>, String>
where
    F: FnMut(SkillInstallProgressUpdate),
{
    let source = object_string(payload, "source")
        .ok_or_else(|| "SkillsManager install requires source".to_string())?;
    let conflict = normalize_conflict(object_string(payload, "conflict"), "backup")?;
    let method = normalize_method(object_string(payload, "method"))?;
    let git_ref = object_string(payload, "ref").unwrap_or(DEFAULT_GITHUB_REF);
    let name_override = object_string(payload, "name")
        .map(sanitize_skill_name)
        .transpose()?;

    let tmp = TempDir::new("liveagent-skill-install")?;
    let stage_root = if is_github_source(source) {
        on_progress(SkillInstallProgressUpdate {
            phase: "downloading",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Preparing GitHub Skill source".to_string()),
        });
        prepare_github_source(source, &method, git_ref, tmp.path())?
    } else if is_http_source(source) {
        prepare_http_source_with_progress(source, tmp.path(), |update| on_progress(update))?
    } else {
        on_progress(SkillInstallProgressUpdate {
            phase: "validating",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Preparing local Skill source".to_string()),
        });
        prepare_local_or_archive_source(source, tmp.path())?
    };

    on_progress(SkillInstallProgressUpdate {
        phase: "validating",
        downloaded_bytes: None,
        total_bytes: None,
        message: Some("Validating Skill metadata".to_string()),
    });
    let candidates = discover_skill_dirs(&stage_root);
    if candidates.is_empty() {
        return Err(
            "No skill directories found. Expected SKILL.md, skill.md, skill.json, or README.md."
                .to_string(),
        );
    }
    if name_override.is_some() && candidates.len() != 1 {
        return Err("name can only be used when exactly one skill is installed".to_string());
    }

    let mut results = Vec::new();
    for candidate in candidates {
        let metadata = read_skill_metadata_from_dir(&candidate)?;
        let skill_name = name_override.as_deref().unwrap_or(&metadata.name);
        ensure_not_builtin_skill_management_target(skill_name, "install")?;
        on_progress(SkillInstallProgressUpdate {
            phase: "installing",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some(format!("Installing Skill {skill_name}")),
        });
        let result = copy_skill_with_conflict(&candidate, root, skill_name, &conflict)?;
        results.push(result);
    }
    write_skill_source_metadata_for_install(root, payload, &results)?;
    Ok(results)
}
