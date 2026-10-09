use std::path::PathBuf;

use bevy::prelude::*;
use bevy_egui::EguiPlugin;

mod map_editor;
mod select_project_menu;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default, States)]
pub enum AppState {
    #[default]
    SelectProjectMenu,
    MapEditor,
}

#[derive(Component)]
struct MainCamera;

#[derive(Component)]
struct CameraZoom {
    min: f32,
    max: f32,
    curr: f32,
}

impl CameraZoom {
    pub fn zoom(&mut self, scroll_value: f32) {
        self.curr *= std::f32::consts::E.powf(-scroll_value);
        self.curr = self.curr.clamp(self.min, self.max);
    }
}

fn setup_camera(mut commands: Commands) {
    commands.spawn((
        MainCamera,
        CameraZoom {
            min: 0.1,
            max: 10.,
            curr: 1.,
        },
        Camera2d::default(),
    ));
}

fn main() {
    let mut app = App::new();
    app.add_plugins(DefaultPlugins)
        .add_plugins(EguiPlugin::default())
        .add_plugins(select_project_menu::SelectProjectMenuPlugin)
        .add_plugins(map_editor::MapEditorPlugin);

    app.init_state::<AppState>();

    app.add_systems(Startup, setup_camera);

    let exit = app.run();
    println!("Exited with {:?}", exit);
}
