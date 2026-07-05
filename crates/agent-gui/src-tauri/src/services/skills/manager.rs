//! SkillsManager 入口：payload 动作解析与 `system_manage_skill_sync` 分发。

use serde_json::Value;

use super::*;

pub(crate) fn action_from_payload(
    payload: &serde_json::Map<String, Value>,
) -> Result<String, String> {
    let action = object_string(payload, "action").unwrap_or_else(|| {
        if object_string(payload, "path").is_some() {
            "read"
        } else {
            "list"
        }
    });
    match action {
        "read" | "list" | "install" | "install_start" | "install_status" | "create"
        | "validate" | "package" | "delete" | "clawhub_search" | "clawhub_install" => {
            Ok(action.to_string())
        }
        _ => Err(format!("SkillsManager action is not supported: {action}")),
    }
}

pub fn system_manage_skill_sync(payload: Value) -> Result<SystemManageSkillResponse, String> {
    let root = skills_root_dir()?;
    let root_dir = skill_root_display(&root);
    let payload = payload
        .as_object()
        .ok_or_else(|| "SkillsManager payload must be an object".to_string())?;
    let action = action_from_payload(payload)?;

    match action.as_str() {
        "read" => {
            let path = object_string(payload, "path")
                .ok_or_else(|| "SkillsManager read requires path".to_string())?;
            let offset = object_usize(payload, "offset");
            let length = object_usize(payload, "length");
            let result = read_skill_text_from_root(&root, path, offset, length)?;
            let num_lines = result.content.match_indices('\n').count()
                + usize::from(!result.content.is_empty() && !result.content.ends_with('\n'));
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: Some(path.to_string()),
                content: Some(result.content),
                truncated: Some(result.truncated),
                start_line: Some(offset.unwrap_or(0) + 1),
                num_lines: Some(num_lines),
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "list" => {
            let (skills, invalid) = list_installed_skills(&root)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: Some(skills),
                invalid: Some(invalid),
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "clawhub_search" => {
            let (clawhub_results, clawhub_next_cursor) =
                search_clawhub_skills_from_payload(payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: Some(clawhub_results),
                clawhub_next_cursor,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "install" => {
            let installed = install_source_from_payload(&root, payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: Some(installed),
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "clawhub_install" => {
            let (installed, slug, download_url) =
                install_clawhub_skill_from_payload(&root, payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: Some(installed),
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: Some(slug),
                clawhub_download_url: Some(download_url),
            })
        }
        "install_start" => {
            let install_job = start_install_job_from_payload(root.clone(), payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: Some(install_job),
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "install_status" => {
            let job_id = object_string(payload, "jobId")
                .or_else(|| object_string(payload, "job_id"))
                .ok_or_else(|| "SkillsManager install_status requires jobId".to_string())?;
            let install_job = get_install_job_snapshot(job_id)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: Some(install_job),
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "create" => {
            let created = create_skill_from_payload(&root, payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: Some(created),
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "validate" => {
            let name = object_string(payload, "name")
                .ok_or_else(|| "SkillsManager validate requires name".to_string())?;
            let validation = validate_installed_skill(&root, name)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: Some(validation),
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "package" => {
            let name = object_string(payload, "name")
                .ok_or_else(|| "SkillsManager package requires name".to_string())?;
            let package = package_installed_skill(&root, name)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: Some(package),
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "delete" => {
            let name = object_string(payload, "name")
                .ok_or_else(|| "SkillsManager delete requires name".to_string())?;
            let deleted = delete_installed_skill(&root, name)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: Some(deleted),
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        _ => Err(format!("SkillsManager action is not supported: {action}")),
    }
}
