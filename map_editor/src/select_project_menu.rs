use std::{collections::HashMap, path::PathBuf};

use bevy::prelude::*;
use bevy_egui::{EguiContexts, EguiPrimaryContextPass, egui};

use crate::{AppState, map_editor::MapEditorParameters};

pub struct SelectProjectMenuPlugin;

impl Plugin for SelectProjectMenuPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::SelectProjectMenu), load_project_list);
        app.add_systems(
            EguiPrimaryContextPass,
            (ui_system).run_if(in_state(AppState::SelectProjectMenu)),
        );
    }
}

struct Project {
    dir_name: String,
    full_path: PathBuf,
}

#[derive(Resource)]
struct ProjectList {
    projects: Vec<Project>,
}

fn update_all_project_floors_from_map_images() -> Result {
    for map in std::fs::read_dir("assets/map_images")? {
        let map = map?;
        let mut map_floors = vec![];

        for floor_img in std::fs::read_dir(map.path())? {
            let floor_img = floor_img?;
            let floor_name = PathBuf::from(floor_img.file_name()).with_extension("");
            map_floors.push(floor_name);
        }

        map_floors.sort();

        let map_floors_file_path = PathBuf::from("projects")
            .join(map.file_name())
            .join("floors.txt");
        let s = map_floors
            .into_iter()
            .flat_map(|floor| {
                format!("{}\n", floor.to_str().unwrap())
                    .chars()
                    .collect::<Vec<_>>()
            })
            .collect::<String>();
        let _ = std::fs::create_dir(PathBuf::from("projects").join(map.file_name()));
        std::fs::write(map_floors_file_path, s)?;
    }

    Ok(())
}

fn load_project_list(mut commands: Commands) -> Result {
    update_all_project_floors_from_map_images().unwrap();

    let mut projects = ProjectList {
        projects: Default::default(),
    };

    for f in std::fs::read_dir("projects")? {
        let f = f?;
        projects.projects.push(Project {
            dir_name: f.file_name().to_str().unwrap().into(),
            full_path: f.path(),
        });
    }

    projects.projects.sort_by_key(|proj| proj.dir_name.clone());

    commands.insert_resource(projects);
    Ok(())
}

fn ui_system(
    mut commands: Commands,
    mut contexts: EguiContexts,
    mut next_app_state: ResMut<NextState<AppState>>,
    project_list: Res<ProjectList>,
) -> Result {
    let ctx = contexts.ctx_mut()?;
    let mut viewport_ui = egui::Ui::new(
        ctx.clone(),
        "viewport".into(),
        egui::UiBuilder::new()
            .layer_id(egui::LayerId::background())
            .max_rect(ctx.viewport_rect()),
    );

    egui::CentralPanel::default().show(&mut viewport_ui, |ui| {
        ui.label("Select Project");
        ui.vertical(|ui| {
            for proj in &project_list.projects {
                if ui.button(&proj.dir_name).clicked() {
                    next_app_state.set(AppState::MapEditor);
                    commands.insert_resource(MapEditorParameters {
                        project_name: proj.dir_name.clone(),
                    });
                }
            }
        });
    });

    Ok(())
}
