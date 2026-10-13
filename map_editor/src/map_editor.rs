use std::{
    collections::{HashMap, HashSet},
    f32::consts::{FRAC_PI_2, PI},
    num::NonZeroU8,
    path::PathBuf,
};

use bevy::{
    input::{InputSystems, mouse::MouseWheel},
    math::bounding::{Aabb2d, BoundingVolume},
    prelude::*,
};
use ordered_float::OrderedFloat;
use serde::{Deserialize, Serialize};
use svg::Node;
use uuid::Uuid;

use crate::{AppState, CameraZoom, MainCamera};

const PROJECT_FILE_NAME: &str = "project.ron";

pub struct MapEditorPlugin;
impl Plugin for MapEditorPlugin {
    fn build(&self, app: &mut App) {
        app.init_gizmo_group::<ScaleReferenceGizmoConfigGroup>()
            .add_systems(OnEnter(AppState::MapEditor), init_gizmo_configs);

        app.insert_resource(MousePos(None))
            .insert_resource(DrawToolState::PlaceVertex(PlaceVertexToolState::default()))
            .insert_resource(HoveredDrawElement(None));

        app.add_systems(OnEnter(AppState::MapEditor), load_selected_project);
        app.add_systems(
            PreUpdate,
            (
                update_mouse_pos,
                handle_undo,
                handle_delete_selection,
                update_hovered_draw_element.after(update_mouse_pos),
            )
                .chain()
                .after(InputSystems)
                .run_if(in_state(AppState::MapEditor)),
        );
        app.add_systems(
            Update,
            (
                change_floor,
                update_background_image,
                move_camera,
                apply_camera_zoom,
                change_selected_draw_tool,
                draw_tool_update,
                update_selection,
                handle_saving,
                update_draw_tool_state_display.after(draw_tool_update),
                update_draw_tool_state_preview.after(draw_tool_update),
                render_draw_elements.after(draw_tool_update),
            )
                .run_if(in_state(AppState::MapEditor)),
        );
    }
}

#[derive(Resource)]
pub struct MapEditorParameters {
    pub project_name: String,
}

fn load_selected_project(
    mut commands: Commands,
    params: Res<MapEditorParameters>,
    assets: Res<AssetServer>,
) {
    let draw_state = DrawState::load_from_project_name(&params.project_name);

    let mut background_img = BackgroundImage {
        curr_floor_idx: usize::MAX,
        img_cache: HashMap::new(),
    };

    for floor_name in &draw_state.floor_names {
        background_img.get_img(&assets, floor_name, &params.project_name);
    }

    commands.spawn((DespawnOnExit(AppState::MapEditor), background_img));

    commands.spawn((
        DespawnOnExit(AppState::MapEditor),
        DrawToolStateDisplayLabel,
        Text::new("---"),
    ));

    commands.insert_resource(draw_state);
}

fn init_gizmo_configs(mut config_store: ResMut<GizmoConfigStore>) {
    let config = config_store
        .config_mut::<ScaleReferenceGizmoConfigGroup>()
        .0;
    config.line.style = GizmoLineStyle::Dotted;
}

#[derive(Component)]
pub struct BackgroundImage {
    curr_floor_idx: usize,
    img_cache: HashMap<String, Handle<Image>>,
}

impl BackgroundImage {
    fn get_img(
        &mut self,
        assets: &AssetServer,
        floor_name: &str,
        project_name: &str,
    ) -> Handle<Image> {
        self.img_cache
            .entry(floor_name.into())
            .or_insert_with(|| {
                let img_path = PathBuf::from("map_images")
                    .join(&project_name)
                    .join(format!("{}.jpg", floor_name));
                assets.load(img_path)
            })
            .clone()
    }
}

fn update_background_image(
    mut commands: Commands,
    imgs: Query<(Entity, &mut BackgroundImage)>,
    draw_state: Res<DrawState>,
    params: Res<MapEditorParameters>,
    assets: Res<AssetServer>,
) {
    for (e, mut img) in imgs {
        if img.curr_floor_idx == draw_state.curr_floor {
            continue;
        }
        img.curr_floor_idx = draw_state.curr_floor;

        let img = img.get_img(
            &assets,
            &draw_state.floor_names[draw_state.curr_floor],
            &params.project_name,
        );
        let mut sprite = Sprite::from_image(img);
        sprite.color = Color::linear_rgba(1., 1., 1., 0.6);

        commands.entity(e).insert(sprite);
    }
}

const SINGLE_DOOR_LENGTH_INSIDE: f32 = 1.4;
const DOUBLE_DOOR_LENGTH_INSIDE: f32 = 2.25;
const HATCH_SIDE_LENGTH: f32 = 2.5;

fn non_zero_u8_one() -> NonZeroU8 {
    NonZeroU8::new(1).unwrap()
}

fn default_draw_state_viewbox() -> Aabb2d {
    Aabb2d::new(Vec2::ZERO, vec2(600., 400.))
}

struct DistanceToLineResult {
    distance: f32,
    nearest_pt: Vec2,
}

trait Vec2Ext {
    fn distance_to_line(
        self,
        line_start: Vec2,
        line_end: Vec2,
        continues_forwards: bool,
        continues_backwards: bool,
    ) -> DistanceToLineResult;
}

impl Vec2Ext for Vec2 {
    fn distance_to_line(
        self,
        line_start: Vec2,
        line_end: Vec2,
        continues_forwards: bool,
        continues_backwards: bool,
    ) -> DistanceToLineResult {
        if line_start.distance_squared(line_end) < 0.0001 {
            return DistanceToLineResult {
                distance: line_start.distance(self),
                nearest_pt: line_start,
            };
        }

        let b = line_end - line_start;
        let p = self - line_start;

        let b_orth = vec2(-b.y, b.x).normalize();

        let signed_dist = p.dot(b_orth);

        let mut nearest_pt = p - b_orth * signed_dist;

        let t = if b.x.abs() > b.y.abs() {
            nearest_pt.x / b.x
        } else {
            nearest_pt.y / b.y
        };

        if t > 1. && !continues_forwards {
            nearest_pt = b;
        } else if t < 0. && !continues_backwards {
            nearest_pt = Vec2::ZERO;
        }

        nearest_pt += line_start;

        DistanceToLineResult {
            distance: self.distance(nearest_pt),
            nearest_pt,
        }
    }
}

fn oriented_bounding_box_contains(
    pt: Vec2,
    obb_center: Vec2,
    obb_halfsize: Vec2,
    obb_rotation: f32,
) -> bool {
    let pt_trans = Vec2::from_angle(-obb_rotation).rotate(pt - obb_center);
    pt_trans.x.abs() <= obb_halfsize.x && pt_trans.y.abs() <= obb_halfsize.y
}

struct Circle {
    center: Vec2,
    radius: f32,
}

impl Circle {
    /// Returns the circumcircle of three points
    fn from_three_points(points: [Vec2; 3]) -> Option<Self> {
        let bisector0_start = 0.5 * (points[0] + points[1]);
        let bisector0_dir = Vec2::Y.rotate(points[0] - points[1]);

        let bisector1_start = 0.5 * (points[0] + points[2]);
        let bisector1_dir = Vec2::Y.rotate(points[0] - points[2]);

        LineIntersection::calculate(
            bisector0_start,
            bisector0_dir,
            bisector1_start,
            bisector1_dir,
        )
        .map(|int| Self {
            center: int.point,
            radius: int.point.distance(points[0]),
        })
    }
}

struct LineIntersection {
    point: Vec2,
    dist_along_a: f32,
    dist_along_b: f32,
}

impl LineIntersection {
    fn calculate(a_start: Vec2, a_dir: Vec2, b_start: Vec2, b_dir: Vec2) -> Option<Self> {
        let a_dir = a_dir.try_normalize()?;
        let b_dir = b_dir.try_normalize()?;

        let mut pts = [a_start, b_start, a_dir, b_dir];

        if b_dir.y.abs() > b_dir.x.abs() {
            pts = pts.map(|v| vec2(v.y, v.x));
        }

        let [d, e, m, n] = pts;

        let n_slope = n.y / n.x;

        let t = (n_slope * (d.x - e.x) - d.y + e.y) / (m.y - n_slope * m.x);

        if !t.is_finite() {
            return None;
        }

        let dist_along_b = (d.x - e.x + m.x * t) / n.x;

        Some(Self {
            point: a_start + a_dir * t,
            dist_along_a: t,
            dist_along_b,
        })
    }
}

/// Excludes the start and end points!
fn evenly_spaced_points_along_line(
    start: Vec2,
    end: Vec2,
    num_points: u32,
) -> impl Iterator<Item = Vec2> {
    (0..num_points).map(move |i| {
        let t = (i + 1) as f32 / (num_points + 1) as f32;
        (1. - t) * start + t * end
    })
}

trait OptDrawElementIdExt {
    fn as_kind<T: DrawElementKind>(self) -> Option<T::Id>;
}

impl OptDrawElementIdExt for Option<DrawElementId> {
    fn as_kind<T: DrawElementKind>(self) -> Option<T::Id> {
        self.and_then(|id| id.as_kind::<T>())
    }
}

trait DrawElementKind {
    type Id: Copy + Eq;
    type Resolved: DrawElementResolved;

    fn id_from_any(id: DrawElementId) -> Option<Self::Id>;

    fn get(draw_state: &DrawState, id: Self::Id) -> &Self;
    fn resolve(&self, draw_state: &DrawState) -> Self::Resolved;
    fn get_resolved(draw_state: &DrawState, id: Self::Id) -> Self::Resolved {
        Self::get(draw_state, id).resolve(draw_state)
    }
}

trait DrawElementResolved {
    type GizmoCfg: GizmoConfigGroup;
    fn render_gizmo(&self, gizmos: &mut Gizmos<Self::GizmoCfg>);
    fn bounding_box(&self) -> Aabb2d;
}

macro_rules! new_id_type {
    ($name:ident) => {
        #[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name {
            floor: usize,
            id: Uuid,
        }
    };
}

new_id_type!(VertexId);
new_id_type!(WallId);
new_id_type!(RectId);
new_id_type!(CircleByThreePointsId);
new_id_type!(DoorId);
new_id_type!(HatchId);

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash)]
struct ScaleReferenceId {
    floor: usize,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash)]
enum WallKind {
    #[default]
    Indestructable,
    Destructable,
    Half,
}

#[derive(Debug, Default)]
struct PlaceVertexToolState {
    prev_point: Option<VertexId>,
    current_placement: Option<Vertex>,
}

#[derive(Debug)]
struct WallToolState {
    start: Option<VertexId>,
    kind: WallKind,
    destructable_segment_count: NonZeroU8,
}

impl Default for WallToolState {
    fn default() -> Self {
        Self {
            start: Default::default(),
            kind: Default::default(),
            destructable_segment_count: non_zero_u8_one(),
        }
    }
}

#[derive(Debug, Clone)]
enum ShapeKind {
    RectangleByDiagonal {
        start: Option<VertexId>,
        skew_angle: f32,
    },
    RectangleAxisAligned {
        start: Option<VertexId>,
    },
    CircleFromThreePoints {
        first_two: Vec<VertexId>,
    },
}

impl Default for ShapeKind {
    fn default() -> Self {
        Self::RectangleAxisAligned { start: None }
    }
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
enum ShapeHeight {
    Full,
    #[default]
    Half,
}

impl ShapeHeight {
    fn gizmo_color(self) -> Color {
        match self {
            ShapeHeight::Full => GizmoStyle::get().full_height_color,
            ShapeHeight::Half => GizmoStyle::get().half_height_color,
        }
    }
}

#[derive(Debug, Default)]
struct ShapeToolState {
    kind: ShapeKind,
    height: ShapeHeight,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
enum DoorKind {
    #[default]
    Single,
    Double,
    SingleWindow,
    DoubleWindow,
}

impl DoorKind {
    /// The x-coordinate is the "wide" direction
    fn size_meters(&self) -> Vec2 {
        let width = match self {
            DoorKind::Single | DoorKind::SingleWindow => SINGLE_DOOR_LENGTH_INSIDE,
            DoorKind::Double | DoorKind::DoubleWindow => DOUBLE_DOOR_LENGTH_INSIDE,
        };

        vec2(width, 0.5)
    }
}

#[derive(Debug, Default)]
struct DoorToolState {
    kind: DoorKind,
}

#[derive(Debug, Default)]
struct HatchToolState {}

#[derive(Debug, Default)]
struct ScaleReferenceToolState {
    start: Option<VertexId>,
    meters: f32,
}

#[derive(Resource, Debug)]
enum DrawToolState {
    PlaceVertex(PlaceVertexToolState),
    Wall(WallToolState),
    Shape(ShapeToolState),
    Door(DoorToolState),
    Hatch(HatchToolState),
    ScaleReference(ScaleReferenceToolState),
}

#[derive(Component)]
struct DrawToolStateDisplayLabel;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Vertex {
    pos: Vec2,
}

impl DrawElementKind for Vertex {
    type Id = VertexId;
    type Resolved = Self;

    fn id_from_any(id: DrawElementId) -> Option<Self::Id> {
        match id {
            DrawElementId::Vertex(id) => Some(id),
            _ => None,
        }
    }

    fn get(draw_state: &DrawState, id: Self::Id) -> &Self {
        &draw_state.vertices[&id]
    }

    fn resolve(&self, _: &DrawState) -> Self::Resolved {
        self.clone()
    }
}

impl DrawElementResolved for Vertex {
    type GizmoCfg = DefaultGizmoConfigGroup;
    fn render_gizmo(&self, gizmos: &mut Gizmos) {
        gizmos.cross_2d(
            Isometry2d::from_translation(self.pos),
            4.,
            Color::linear_rgb(1., 0., 0.),
        );
    }

    fn bounding_box(&self) -> Aabb2d {
        Aabb2d::new(self.pos, Vec2::splat(5.))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Wall<V = VertexId> {
    start: V,
    end: V,
    kind: WallKind,
    #[serde(default = "non_zero_u8_one")]
    destructable_segment_count: NonZeroU8,
}

impl Wall<Vec2> {
    fn cross_axis(&self) -> Vec2 {
        Vec2::from_angle(FRAC_PI_2)
            .rotate(self.end - self.start)
            .normalize_or_zero()
            * 2.
    }
}

impl DrawElementKind for Wall {
    type Id = WallId;
    type Resolved = Wall<Vec2>;

    fn id_from_any(id: DrawElementId) -> Option<Self::Id> {
        match id {
            DrawElementId::Wall(id) => Some(id),
            _ => None,
        }
    }

    fn get(draw_state: &DrawState, id: Self::Id) -> &Self {
        &draw_state.walls[&id]
    }

    fn resolve(&self, draw_state: &DrawState) -> Self::Resolved {
        Wall {
            start: draw_state.vertices[&self.start].pos,
            end: draw_state.vertices[&self.end].pos,
            kind: self.kind,
            destructable_segment_count: self.destructable_segment_count,
        }
    }
}

impl DrawElementResolved for Wall<Vec2> {
    type GizmoCfg = DefaultGizmoConfigGroup;
    fn render_gizmo(&self, gizmos: &mut Gizmos) {
        let color = match self.kind {
            WallKind::Indestructable => GizmoStyle::get().full_height_color,
            WallKind::Destructable => GizmoStyle::get().destructable_color,
            WallKind::Half => GizmoStyle::get().half_height_color,
        };
        gizmos.line_2d(self.start, self.end, color);

        let cross_axis = self.cross_axis();

        if let WallKind::Destructable = self.kind {
            for tick_center in evenly_spaced_points_along_line(
                self.start,
                self.end,
                self.destructable_segment_count.get() as u32 - 1,
            ) {
                gizmos.line_2d(tick_center - cross_axis, tick_center + cross_axis, color);
            }
        }
    }

    fn bounding_box(&self) -> Aabb2d {
        Aabb2d {
            min: Vec2::min(self.start, self.end),
            max: Vec2::max(self.start, self.end),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Rect<V = VertexId> {
    start: V,
    end: V,
    skew: f32,
    #[serde(default)]
    height: ShapeHeight,
}

impl Rect<Vec2> {
    fn axis_aligned(start: Vec2, end: Vec2, height: ShapeHeight) -> Self {
        Self {
            start,
            end,
            skew: -2. * (end - start).to_angle(),
            height,
        }
    }

    fn center(&self) -> Vec2 {
        0.5 * (self.start + self.end)
    }

    /// Returns the points on the cross diagonal starting from the "right" side
    fn cross_diagonal_points(&self) -> [Vec2; 2] {
        let offset = Vec2::from_angle(self.skew).rotate(self.end - self.start) * 0.5;
        [self.center() + offset, self.center() - offset]
    }

    fn corners_ccw(&self) -> [Vec2; 4] {
        let cross = self.cross_diagonal_points();
        [self.start, cross[0], self.end, cross[1]]
    }

    fn from_rotated_center_size(center: Vec2, rot: f32, size: Vec2, height: ShapeHeight) -> Self {
        let halfsize = 0.5 * size;
        let rot_vec = Vec2::from_angle(rot);

        let start = center + rot_vec.rotate(vec2(-halfsize.x, halfsize.y));
        let end = center + rot_vec.rotate(vec2(halfsize.x, -halfsize.y));

        let right = center + rot_vec.rotate(-halfsize);

        let skew = (start - center).angle_to(right - center);

        Self {
            start,
            end,
            skew,
            height,
        }
    }

    /// Returns this rectangle in the form of `(center and rotation, size)`
    fn as_rotated_center_size(&self) -> (Isometry2d, Vec2) {
        let cross = self.cross_diagonal_points();
        let size = vec2(cross[1].distance(self.start), cross[0].distance(self.start));
        let rot = FRAC_PI_2 + (cross[0] - self.start).to_angle();

        (Isometry2d::new(self.center(), Rot2::radians(rot)), size)
    }

    fn contains(&self, pt: Vec2) -> bool {
        let (iso, size) = self.as_rotated_center_size();
        oriented_bounding_box_contains(pt, iso.translation, 0.5 * size, iso.rotation.as_radians())
    }
}

impl DrawElementKind for Rect {
    type Id = RectId;
    type Resolved = Rect<Vec2>;

    fn id_from_any(id: DrawElementId) -> Option<Self::Id> {
        match id {
            DrawElementId::Rect(id) => Some(id),
            _ => None,
        }
    }

    fn get(draw_state: &DrawState, id: Self::Id) -> &Self {
        &draw_state.rectangles[&id]
    }

    fn resolve(&self, draw_state: &DrawState) -> Self::Resolved {
        Rect {
            start: draw_state.vertices[&self.start].pos,
            end: draw_state.vertices[&self.end].pos,
            skew: self.skew,
            height: self.height,
        }
    }
}

impl DrawElementResolved for Rect<Vec2> {
    type GizmoCfg = DefaultGizmoConfigGroup;
    fn render_gizmo(&self, gizmos: &mut Gizmos) {
        let color = self.height.gizmo_color();

        let (iso, size) = self.as_rotated_center_size();
        gizmos.rect_2d(iso, size, color);
    }

    fn bounding_box(&self) -> Aabb2d {
        Aabb2d::from_point_cloud(Isometry2d::IDENTITY, &self.corners_ccw())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CircleByThreePoints<V = VertexId> {
    points: [V; 3],
    #[serde(default)]
    height: ShapeHeight,
}

impl DrawElementKind for CircleByThreePoints {
    type Id = CircleByThreePointsId;
    type Resolved = CircleByThreePoints<Vec2>;

    fn id_from_any(id: DrawElementId) -> Option<Self::Id> {
        match id {
            DrawElementId::CircleByThreePoints(id) => Some(id),
            _ => None,
        }
    }

    fn get(draw_state: &DrawState, id: Self::Id) -> &Self {
        &draw_state.circles_by_three_points[&id]
    }

    fn resolve(&self, draw_state: &DrawState) -> Self::Resolved {
        CircleByThreePoints {
            points: self.points.map(|vtx| draw_state.vertices[&vtx].pos),
            height: self.height,
        }
    }
}

impl DrawElementResolved for CircleByThreePoints<Vec2> {
    type GizmoCfg = DefaultGizmoConfigGroup;
    fn render_gizmo(&self, gizmos: &mut Gizmos) {
        if let Some(circle_math) = Circle::from_three_points(self.points) {
            gizmos.circle_2d(
                Isometry2d::from_translation(circle_math.center),
                circle_math.radius,
                self.height.gizmo_color(),
            );
        }
    }

    fn bounding_box(&self) -> Aabb2d {
        let circle_math = Circle::from_three_points(self.points).unwrap();

        Aabb2d::new(circle_math.center, Vec2::splat(circle_math.radius))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Door {
    wall: WallId,
    center: Vec2,
    kind: DoorKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DoorResolved {
    wall: Wall<Vec2>,
    center: Vec2,
    kind: DoorKind,
    pixels_per_meter: f32,
}

impl DoorResolved {
    fn get_gizmo_rect(&self) -> Rect<Vec2> {
        let dir = self.wall.end - self.wall.start;

        Rect::from_rotated_center_size(
            self.center,
            dir.to_angle(),
            self.kind.size_meters() * self.pixels_per_meter,
            ShapeHeight::Full,
        )
    }
}

impl DrawElementKind for Door {
    type Id = DoorId;
    type Resolved = DoorResolved;

    fn id_from_any(id: DrawElementId) -> Option<Self::Id> {
        match id {
            DrawElementId::Door(id) => Some(id),
            _ => None,
        }
    }

    fn get(draw_state: &DrawState, id: Self::Id) -> &Self {
        &draw_state.doors[&id]
    }

    fn resolve(&self, draw_state: &DrawState) -> Self::Resolved {
        DoorResolved {
            wall: Wall::get_resolved(draw_state, self.wall),
            center: self.center,
            kind: self.kind.clone(),
            pixels_per_meter: draw_state.pixels_per_meter(),
        }
    }
}

impl DrawElementResolved for DoorResolved {
    type GizmoCfg = DefaultGizmoConfigGroup;
    fn render_gizmo(&self, gizmos: &mut Gizmos) {
        let color = match self.kind {
            DoorKind::Single | DoorKind::Double => Color::linear_rgb(1., 0., 0.),
            DoorKind::SingleWindow | DoorKind::DoubleWindow => Color::linear_rgb(0., 1., 0.),
        };
        let rect = self.get_gizmo_rect();
        let (iso, size) = rect.as_rotated_center_size();
        gizmos.rounded_rect_2d(iso, size, color);
    }

    fn bounding_box(&self) -> Aabb2d {
        self.get_gizmo_rect().bounding_box()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Hatch {
    top_left: VertexId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HatchResolved {
    top_left: Vec2,
    pixels_per_meter: f32,
}

impl DrawElementKind for Hatch {
    type Id = HatchId;
    type Resolved = HatchResolved;

    fn id_from_any(id: DrawElementId) -> Option<Self::Id> {
        match id {
            DrawElementId::Hatch(id) => Some(id),
            _ => None,
        }
    }

    fn get(draw_state: &DrawState, id: Self::Id) -> &Self {
        &draw_state.hatches[&id]
    }

    fn resolve(&self, draw_state: &DrawState) -> Self::Resolved {
        HatchResolved {
            top_left: draw_state.vertices[&self.top_left].pos,
            pixels_per_meter: draw_state.pixels_per_meter(),
        }
    }
}

impl DrawElementResolved for HatchResolved {
    type GizmoCfg = DefaultGizmoConfigGroup;
    fn render_gizmo(&self, gizmos: &mut Gizmos) {
        let aabb = self.bounding_box();
        gizmos.rect_2d(
            Isometry2d::from_translation(aabb.center()),
            aabb.half_size() * 2.,
            Color::linear_rgb(1., 1., 0.),
        );
    }

    fn bounding_box(&self) -> Aabb2d {
        Aabb2d {
            min: vec2(
                self.top_left.x,
                self.top_left.y - self.pixels_per_meter * HATCH_SIDE_LENGTH,
            ),
            max: vec2(
                self.top_left.x + self.pixels_per_meter * HATCH_SIDE_LENGTH,
                self.top_left.y,
            ),
        }
    }
}

#[derive(Default, Reflect, GizmoConfigGroup)]
struct ScaleReferenceGizmoConfigGroup;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScaleReference<V = VertexId> {
    endpoints: [V; 2],
    meters: f32,
}

impl DrawElementKind for ScaleReference {
    type Id = ScaleReferenceId;
    type Resolved = ScaleReference<Vec2>;

    fn id_from_any(id: DrawElementId) -> Option<Self::Id> {
        match id {
            DrawElementId::ScaleReference(id) => Some(id),
            _ => None,
        }
    }

    fn get(draw_state: &DrawState, _: Self::Id) -> &Self {
        &draw_state.scale_reference.as_ref().unwrap().1
    }

    fn resolve(&self, draw_state: &DrawState) -> Self::Resolved {
        ScaleReference {
            endpoints: self.endpoints.map(|v| draw_state.vertices[&v].pos),
            meters: self.meters,
        }
    }
}

impl DrawElementResolved for ScaleReference<Vec2> {
    type GizmoCfg = ScaleReferenceGizmoConfigGroup;
    fn render_gizmo(&self, gizmos: &mut Gizmos<ScaleReferenceGizmoConfigGroup>) {
        let color = GizmoStyle::get().scale_ref_color;

        gizmos.line_2d(self.endpoints[0], self.endpoints[1], color);

        let dir = if self.endpoints[1].x > self.endpoints[0].x {
            self.endpoints[1] - self.endpoints[0]
        } else {
            self.endpoints[0] - self.endpoints[1]
        }
        .normalize_or(Vec2::Y);
        let center = (self.endpoints[0] + self.endpoints[1]) / 2.;
        gizmos.text_2d(
            Isometry2d::new(
                center + Vec2::from_angle(FRAC_PI_2).rotate(dir) * 8.,
                Rot2::radians(dir.to_angle()),
            ),
            &format!("{}m", self.meters),
            10.,
            Vec2::ZERO,
            color,
        );
    }

    fn bounding_box(&self) -> Aabb2d {
        Aabb2d {
            min: self.endpoints[0].min(self.endpoints[1]),
            max: self.endpoints[0].max(self.endpoints[1]),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DrawElementId {
    Vertex(VertexId),
    Wall(WallId),
    Rect(RectId),
    CircleByThreePoints(CircleByThreePointsId),
    Door(DoorId),
    Hatch(HatchId),
    ScaleReference(ScaleReferenceId),
}

impl DrawElementId {
    fn as_kind<T: DrawElementKind>(self) -> Option<T::Id> {
        T::id_from_any(self)
    }

    fn floor(self) -> usize {
        match self {
            DrawElementId::Vertex(id) => id.floor,
            DrawElementId::Wall(id) => id.floor,
            DrawElementId::Rect(id) => id.floor,
            DrawElementId::CircleByThreePoints(id) => id.floor,
            DrawElementId::Door(id) => id.floor,
            DrawElementId::Hatch(id) => id.floor,
            DrawElementId::ScaleReference(id) => id.floor,
        }
    }
}

#[derive(Debug, Clone)]
enum PrevDrawAction {
    PlaceObject(DrawElementId),
}

/// It's expected that, at any time, any `DrawElementId` within the DrawState is valid
#[derive(Resource, Serialize, Deserialize)]
struct DrawState {
    #[serde(default)]
    vertices: HashMap<VertexId, Vertex>,
    #[serde(default)]
    walls: HashMap<WallId, Wall>,
    #[serde(default)]
    rectangles: HashMap<RectId, Rect>,
    #[serde(default)]
    circles_by_three_points: HashMap<CircleByThreePointsId, CircleByThreePoints>,
    #[serde(default)]
    doors: HashMap<DoorId, Door>,
    #[serde(default)]
    hatches: HashMap<HatchId, Hatch>,
    #[serde(default)]
    scale_reference: Option<(ScaleReferenceId, ScaleReference)>,

    /// NOTE: This aabb is in world coordinates, not accounting for the y-flip of SVG coordinates!
    #[serde(skip)]
    #[serde(default = "default_draw_state_viewbox")]
    viewbox: Aabb2d,
    #[serde(skip)]
    floor_names: Vec<String>,
    #[serde(skip)]
    prev_actions: Vec<PrevDrawAction>,
    #[serde(skip)]
    selection: HashSet<DrawElementId>,
    #[serde(skip)]
    curr_floor: usize,
}

impl Default for DrawState {
    fn default() -> Self {
        Self {
            vertices: Default::default(),
            walls: Default::default(),
            rectangles: Default::default(),
            circles_by_three_points: Default::default(),
            doors: Default::default(),
            hatches: Default::default(),
            scale_reference: None,

            viewbox: default_draw_state_viewbox(),
            floor_names: Default::default(),
            prev_actions: Default::default(),
            selection: Default::default(),
            curr_floor: Default::default(),
        }
    }
}

impl DrawState {
    const SELECT_DISTANCE: f32 = 8.;

    fn pixels_per_meter(&self) -> f32 {
        match &self.scale_reference {
            Some((_, scale_ref)) => {
                let scale_ref = scale_ref.resolve(self);
                let dist_px = scale_ref.endpoints[0].distance(scale_ref.endpoints[1]);
                let dist_m = scale_ref.meters;

                dist_px / dist_m
            }
            None => 10.,
        }
    }

    fn load_from_project_name(project_name: &str) -> Self {
        let project_dir = PathBuf::from("projects").join(project_name);
        let draw_state_data_file = project_dir.join(PROJECT_FILE_NAME);

        let floors_txt_contents = std::fs::read_to_string(project_dir.join("floors.txt")).unwrap();
        let floor_names = floors_txt_contents
            .split("\n")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let viewbox = match std::fs::read_to_string(project_dir.join("viewbox.txt")).map(|txt| {
            txt.split(",")
                .map(|elem| elem.trim().to_string())
                .filter(|elem| !elem.is_empty())
                .filter_map(|elem| elem.parse::<f32>().ok())
                .collect::<Vec<_>>()
        }) {
            Ok(viewbox_file_parts) if viewbox_file_parts.len() >= 4 => Aabb2d {
                min: vec2(viewbox_file_parts[0], viewbox_file_parts[1]),
                max: vec2(viewbox_file_parts[2], viewbox_file_parts[3]),
            },
            _ => default_draw_state_viewbox(),
        };

        let mut draw_state: DrawState = if let Some(loaded) =
            std::fs::read_to_string(draw_state_data_file)
                .ok()
                .and_then(|s| ron::from_str(&s).ok())
        {
            loaded
        } else {
            DrawState::default()
        };

        draw_state.floor_names = floor_names;
        draw_state.viewbox = viewbox;

        draw_state
    }

    fn render_floor_to_svg(&self, floor: usize, style: &RenderStyle) -> svg::Document {
        fn create_path_data(
            points: impl IntoIterator<Item = Vec2>,
        ) -> svg::node::element::path::Data {
            let mut data = svg::node::element::path::Data::new();

            let mut started = false;

            for pt in points {
                if started {
                    data = data.line_to((pt.x, pt.y));
                } else {
                    started = true;
                    data = data.move_to((pt.x, pt.y));
                }
            }

            data.close()
        }

        let transform = "scale(1, -1)";

        let mut document = svg::Document::new();

        let vbmin = vec2(self.viewbox.min.x, -self.viewbox.max.y);
        let vbmax = vec2(self.viewbox.max.x, -self.viewbox.min.y);

        document.append(
            svg::node::element::Rectangle::new()
                .set("x", vbmin.x)
                .set("y", vbmin.y)
                .set("width", vbmax.x - vbmin.x)
                .set("height", vbmax.y - vbmin.y)
                .set("fill", style.background_color.to_srgba().to_hex()),
        );

        // Rectangles
        for (id, rect) in &self.rectangles {
            if id.floor != floor {
                continue;
            }

            let rect = rect.resolve(self);

            let data = create_path_data(rect.corners_ccw());

            let color = match rect.height {
                ShapeHeight::Full => style.full_height_color,
                ShapeHeight::Half => style.half_height_color,
            };

            document.append(
                svg::node::element::Path::new()
                    .set("transform", transform)
                    .set("fill", color.to_srgba().to_hex())
                    .set("stroke", color.to_srgba().to_hex())
                    .set("stroke-width", 0.75)
                    .set("d", data),
            );
        }

        // Circles
        for (id, circle) in &self.circles_by_three_points {
            if id.floor != floor {
                continue;
            }

            let circle_math = Circle::from_three_points(circle.resolve(self).points).unwrap();

            let color = match circle.height {
                ShapeHeight::Full => style.full_height_color,
                ShapeHeight::Half => style.half_height_color,
            };

            document.append(
                svg::node::element::Circle::new()
                    .set("transform", transform)
                    .set("fill", color.to_srgba().to_hex())
                    .set("stroke", "none")
                    .set("cx", circle_math.center.x)
                    .set("cy", circle_math.center.y)
                    .set("r", circle_math.radius),
            )
        }

        // Hatches
        for (id, hatch) in &self.hatches {
            if id.floor != floor {
                continue;
            }

            let stroke_width = 0.15 * self.pixels_per_meter();

            let hatch_res = hatch.resolve(self);
            let aabb = hatch_res.bounding_box();

            let bot_left = aabb.min;
            let top_left = vec2(aabb.min.x, aabb.max.y);
            let top_right = aabb.max;
            let bot_right = vec2(aabb.max.x, aabb.min.y);

            let color = style.destructable_color;

            document.append(
                svg::node::element::Path::new()
                    .set("transform", transform)
                    .set("fill", "none")
                    .set("stroke", color.to_srgba().to_hex())
                    .set("stroke-width", stroke_width)
                    .set("stroke-linejoin", "round")
                    .set(
                        "d",
                        create_path_data([
                            bot_left, top_right, top_left, bot_right, bot_left, top_left,
                            top_right, bot_right,
                        ]),
                    ),
            );
        }

        // Walls & Doors
        for (wall_id, wall) in &self.walls {
            if wall_id.floor != floor {
                continue;
            }

            let stroke_width = 0.3 * self.pixels_per_meter();

            let wall = wall.resolve(self);

            let color = match wall.kind {
                WallKind::Indestructable => style.full_height_color,
                WallKind::Destructable => style.destructable_color,
                WallKind::Half => style.half_height_color,
            };

            let mut doors_on_wall = self
                .doors
                .iter()
                .filter(|(id, door)| id.floor == floor && door.wall == *wall_id)
                .collect::<Vec<_>>();
            doors_on_wall.sort_by_key(|(_, door)| {
                OrderedFloat(door.resolve(self).center.distance(wall.start))
            });

            let wall_dir = (wall.end - wall.start).normalize_or_zero();
            let mut prev_pt = wall.start;
            for (_, door) in doors_on_wall {
                let door = door.resolve(self);

                let door_width = door.kind.size_meters().x * self.pixels_per_meter();

                let door_start = door.center - wall_dir * door_width / 2.;
                let door_end = door_start + wall_dir * door_width;

                document.append(
                    svg::node::element::Path::new()
                        .set("transform", transform)
                        .set("fill", "none")
                        .set("stroke", color.to_srgba().to_hex())
                        .set("stroke-width", stroke_width)
                        .set("d", create_path_data([prev_pt, door_start])),
                );

                prev_pt = door_end;
            }
            document.append(
                svg::node::element::Path::new()
                    .set("transform", transform)
                    .set("fill", "none")
                    .set("stroke", color.to_srgba().to_hex())
                    .set("stroke-width", stroke_width)
                    .set("d", create_path_data([prev_pt, wall.end])),
            );

            let cross_axis = Vec2::from_angle(FRAC_PI_2)
                .rotate(wall_dir)
                .normalize_or_zero()
                * 5.;

            for tick_center in evenly_spaced_points_along_line(
                wall.start,
                wall.end,
                if let WallKind::Destructable = wall.kind {
                    wall.destructable_segment_count.get() as u32 - 1
                } else {
                    0
                },
            ) {
                let tick_start = tick_center - cross_axis;
                let tick_end = tick_center + cross_axis;

                let data = create_path_data([tick_start, tick_end]);

                document.append(
                    svg::node::element::Path::new()
                        .set("transform", transform)
                        .set("fill", "none")
                        .set("stroke", color.to_srgba().to_hex())
                        .set("stroke-width", stroke_width as f32 / 2.)
                        .set("d", data),
                );
            }
        }

        document = document.set(
            "viewBox",
            (vbmin.x, vbmin.y, vbmax.x - vbmin.x, vbmax.y - vbmin.y),
        );

        document
    }

    fn save_and_render(
        &self,
        save_dir: impl AsRef<std::path::Path>,
        render_dir: impl AsRef<std::path::Path>,
    ) {
        let save_dir = save_dir.as_ref();
        let render_dir = render_dir.as_ref();
        std::fs::create_dir_all(save_dir).unwrap();
        std::fs::create_dir_all(render_dir).unwrap();

        std::fs::write(
            save_dir.join(PROJECT_FILE_NAME),
            ron::to_string(self).unwrap(),
        )
        .unwrap();

        for floor in 0..self.floor_names.len() {
            let floor_name = &self.floor_names[floor];
            for style in RenderStyle::load_all() {
                let path = render_dir.join(format!("{floor_name}_{}.svg", style.name));

                let document = self.render_floor_to_svg(floor, &style);

                svg::save(path, &document).unwrap();
            }
        }
    }

    fn remove_element(&mut self, generic_id: DrawElementId) {
        self.selection.remove(&generic_id);
        match generic_id {
            DrawElementId::Vertex(id) => {
                self.vertices.remove(&id);

                self.walls
                    .retain(|_, wall| wall.start != id && wall.end != id);
                self.rectangles
                    .retain(|_, rect| rect.start != id && rect.end != id);
                self.circles_by_three_points
                    .retain(|_, c| !c.points.contains(&id));

                for id in self.doors.keys().cloned().collect::<Vec<_>>() {
                    if !self.walls.contains_key(&self.doors[&id].wall) {
                        self.doors.remove(&id);
                    }
                }

                self.hatches.retain(|_, hatch| hatch.top_left != id);

                if self
                    .scale_reference
                    .as_ref()
                    .is_some_and(|(_, scale_ref)| scale_ref.endpoints.contains(&id))
                {
                    self.scale_reference = None;
                }
            }
            DrawElementId::Wall(id) => {
                self.walls.remove(&id);
                self.doors.retain(|_, door| door.wall != id);
            }
            DrawElementId::Rect(id) => {
                self.rectangles.remove(&id);
            }
            DrawElementId::CircleByThreePoints(id) => {
                self.circles_by_three_points.remove(&id);
            }
            DrawElementId::Door(id) => {
                self.doors.remove(&id);
            }
            DrawElementId::Hatch(id) => {
                self.hatches.remove(&id);
            }
            DrawElementId::ScaleReference(_) => {
                self.scale_reference = None;
            }
        }
    }

    fn all_draw_elements(&self) -> impl Iterator<Item = DrawElementId> {
        self.vertices
            .keys()
            .map(|id| DrawElementId::Vertex(*id))
            .chain(self.walls.keys().map(|id| DrawElementId::Wall(*id)))
            .chain(self.rectangles.keys().map(|id| DrawElementId::Rect(*id)))
            .chain(
                self.circles_by_three_points
                    .keys()
                    .map(|id| DrawElementId::CircleByThreePoints(*id)),
            )
            .chain(self.doors.keys().map(|id| DrawElementId::Door(*id)))
            .chain(self.hatches.keys().map(|id| DrawElementId::Hatch(*id)))
            .chain(
                self.scale_reference
                    .as_ref()
                    .map(|(id, _)| DrawElementId::ScaleReference(*id)),
            )
    }

    fn distance_to(&self, id: &DrawElementId, mouse_pos: Vec2) -> f32 {
        match id {
            DrawElementId::Vertex(id) => self.vertices[id].pos.distance(mouse_pos),
            DrawElementId::Wall(id) => {
                let wall = Wall::get_resolved(self, *id);
                mouse_pos
                    .distance_to_line(wall.start, wall.end, false, false)
                    .distance
            }
            DrawElementId::Rect(id) => {
                let rect = Rect::get_resolved(self, *id);

                // FIXME: Maybe add actual distance calculation? Although selection should require clicking within the shape
                if rect.contains(mouse_pos) { 0. } else { 1000. }
            }
            DrawElementId::CircleByThreePoints(id) => {
                let circle = &self.circles_by_three_points[id];
                if let Some(circle_math) =
                    Circle::from_three_points(circle.points.map(|vtx| self.vertices[&vtx].pos))
                {
                    if mouse_pos.distance(circle_math.center) <= circle_math.radius {
                        0.
                    } else {
                        1000.
                    }
                } else {
                    1000.
                }
            }
            DrawElementId::Door(id) => {
                let door = Door::get_resolved(self, *id);
                let rect = door.get_gizmo_rect();

                if rect.contains(mouse_pos) { 0. } else { 1000. }
            }
            DrawElementId::Hatch(id) => {
                let hatch = Hatch::get_resolved(self, *id);
                let aabb = hatch.bounding_box();
                let rect = Rect::from_rotated_center_size(
                    aabb.center(),
                    0.,
                    aabb.half_size() * 2.,
                    ShapeHeight::Full,
                );

                if rect.contains(mouse_pos) { 0. } else { 1000. }
            }
            DrawElementId::ScaleReference(id) => {
                let scale = ScaleReference::get_resolved(self, *id);
                mouse_pos
                    .distance_to_line(scale.endpoints[0], scale.endpoints[1], false, false)
                    .distance
            }
        }
    }

    fn pick(&self, mouse_pos: Vec2, vertex_has_priority: bool) -> Option<DrawElementId> {
        let mut ret: Option<(DrawElementId, f32)> = None;

        for id in self.all_draw_elements() {
            if id.floor() != self.curr_floor {
                continue;
            }

            let dist = self.distance_to(&id, mouse_pos);
            if dist < Self::SELECT_DISTANCE
                && ret.is_none_or(|(ret_id, ret_dist)| {
                    if vertex_has_priority {
                        match (id, ret_id) {
                            (DrawElementId::Vertex(_), DrawElementId::Vertex(_)) => dist < ret_dist,
                            (DrawElementId::Vertex(_), _) => true,
                            (_, DrawElementId::Vertex(_)) => false,
                            (_, _) => dist < ret_dist,
                        }
                    } else {
                        dist < ret_dist
                    }
                })
            {
                ret = Some((id, dist));
            }
        }

        ret.map(|(id, _)| id)
    }

    fn bounding_box(&self, id: &DrawElementId) -> Aabb2d {
        match id {
            DrawElementId::Vertex(id) => Vertex::get_resolved(self, *id).bounding_box(),
            DrawElementId::Wall(id) => Wall::get_resolved(self, *id).bounding_box(),
            DrawElementId::Rect(id) => Rect::get_resolved(self, *id).bounding_box(),
            DrawElementId::CircleByThreePoints(id) => {
                CircleByThreePoints::get_resolved(self, *id).bounding_box()
            }
            DrawElementId::Door(id) => Door::get_resolved(self, *id).bounding_box(),
            DrawElementId::Hatch(id) => Hatch::get_resolved(self, *id).bounding_box(),
            DrawElementId::ScaleReference(id) => {
                ScaleReference::get_resolved(self, *id).bounding_box()
            }
        }
    }

    fn selection_as<T: DrawElementKind>(&self) -> Vec<T::Id> {
        self.selection
            .iter()
            .filter_map(|id| T::id_from_any(*id))
            .collect()
    }
}

struct GizmoStyle {
    destructable_color: Color,
    full_height_color: Color,
    half_height_color: Color,
    scale_ref_color: Color,
}

impl GizmoStyle {
    fn get() -> Self {
        const {
            Self {
                destructable_color: Color::linear_rgb(0.95, 0.95, 0.2),
                full_height_color: Color::linear_rgb(0.05, 0.05, 0.1),
                half_height_color: Color::linear_rgb(0.95, 0.95, 1.),
                scale_ref_color: Color::linear_rgb(0., 0.4, 1.),
            }
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RenderStyle {
    #[serde(skip)]
    name: String,
    background_color: Color,
    destructable_color: Color,
    full_height_color: Color,
    half_height_color: Color,
}

impl RenderStyle {
    fn load_all() -> Vec<RenderStyle> {
        let path = "assets/styles";
        let mut styles = vec![];
        for f in std::fs::read_dir(path).unwrap() {
            let Ok(f) = f else {
                continue;
            };
            if let Ok(f_str) = std::fs::read_to_string(f.path()) {
                if let Ok(mut style) = toml::from_str::<RenderStyle>(&f_str) {
                    let mut style_name = PathBuf::from(f.file_name());
                    style_name.set_extension("");
                    style.name = style_name.to_string_lossy().into();

                    styles.push(style);
                }
            }
        }

        styles
    }
}

#[derive(Resource, Debug, Default, Deref)]
pub struct HoveredDrawElement(pub Option<DrawElementId>);

#[derive(Resource, Debug, Default, Deref)]
pub struct MousePos(pub Option<Vec2>);

fn update_mouse_pos(
    camera: Single<(&Camera, &GlobalTransform), With<MainCamera>>,
    window: Single<&Window>,
    mut mouse_world_coords: ResMut<MousePos>,
) {
    mouse_world_coords.0 = window.cursor_position().map(|pos| {
        let (camera, camera_transform) = camera.into_inner();
        camera
            .viewport_to_world_2d(camera_transform, pos)
            .unwrap_or(vec2(0.0, 0.0))
    });
}

fn update_hovered_draw_element(
    mut hovered_elem: ResMut<HoveredDrawElement>,
    mouse_pos: Res<MousePos>,
    draw_state: Res<DrawState>,
) {
    hovered_elem.0 = mouse_pos
        .0
        .and_then(|mouse_pos| draw_state.pick(mouse_pos, true));
}

fn move_camera(
    camera: Single<(&Camera, &mut CameraZoom, &mut Transform), With<MainCamera>>,
    time: Res<Time>,
    keyboard: Res<ButtonInput<KeyCode>>,
    mut scroll_wheel_reader: MessageReader<MouseWheel>,
) {
    let (_, mut zoom, mut trans) = camera.into_inner();

    let mut delta = Vec2::ZERO;

    if keyboard.pressed(KeyCode::KeyW) {
        delta.y += 1.;
    }
    if keyboard.pressed(KeyCode::KeyS) {
        delta.y -= 1.;
    }
    if keyboard.pressed(KeyCode::KeyA) {
        delta.x -= 1.;
    }
    if keyboard.pressed(KeyCode::KeyD) {
        delta.x += 1.;
    }

    trans.translation += delta.extend(0.) * 500. * zoom.curr * time.delta_secs();

    for scroll_event in scroll_wheel_reader.read() {
        zoom.zoom(scroll_event.y * 0.003);
    }
}

fn apply_camera_zoom(cameras: Query<(&CameraZoom, &mut Projection)>) {
    for (zoom, mut proj) in cameras {
        match &mut *proj {
            Projection::Orthographic(proj) => proj.scale = zoom.curr,
            _ => todo!(),
        }
    }
}

fn update_draw_tool_state_display(
    disp: Query<&mut Text, With<DrawToolStateDisplayLabel>>,
    tool_state: Res<DrawToolState>,
) {
    for mut text in disp {
        text.0 = format!("{:?}", *tool_state);
    }
}

fn render_draw_elements(
    mut gizmos: Gizmos,
    mut gizmos_scale_ref: Gizmos<ScaleReferenceGizmoConfigGroup>,
    draw_state: Res<DrawState>,
) {
    gizmos.rect_2d(
        Isometry2d::from_translation(draw_state.viewbox.center()),
        draw_state.viewbox.half_size() * 2.,
        Color::linear_rgb(0., 1., 0.),
    );

    for (id, vtx) in &draw_state.vertices {
        if id.floor == draw_state.curr_floor {
            vtx.resolve(&draw_state).render_gizmo(&mut gizmos);
        }
    }

    for (id, wall) in &draw_state.walls {
        if id.floor == draw_state.curr_floor {
            wall.resolve(&draw_state).render_gizmo(&mut gizmos);
        }
    }

    for (id, rect) in &draw_state.rectangles {
        if id.floor == draw_state.curr_floor {
            rect.resolve(&draw_state).render_gizmo(&mut gizmos);
        }
    }

    for (id, circle) in &draw_state.circles_by_three_points {
        if id.floor == draw_state.curr_floor {
            circle.resolve(&draw_state).render_gizmo(&mut gizmos);
        }
    }

    for (id, door) in &draw_state.doors {
        if id.floor == draw_state.curr_floor {
            door.resolve(&draw_state).render_gizmo(&mut gizmos);
        }
    }

    for (id, hatch) in &draw_state.hatches {
        if id.floor == draw_state.curr_floor {
            hatch.resolve(&draw_state).render_gizmo(&mut gizmos);
        }
    }

    if let Some((id, scale_ref)) = &draw_state.scale_reference {
        if id.floor == draw_state.curr_floor {
            scale_ref
                .resolve(&draw_state)
                .render_gizmo(&mut gizmos_scale_ref);
        }
    }

    for id in &draw_state.selection {
        let aabb = draw_state.bounding_box(id);
        gizmos.rect_2d(
            Isometry2d::from_translation(aabb.center()),
            aabb.half_size() * 2.,
            Color::linear_rgb(0., 0., 1.),
        );
    }
}

fn update_draw_tool_state_preview(
    mut gizmos: Gizmos,
    mut gizmos_scale_ref: Gizmos<ScaleReferenceGizmoConfigGroup>,
    tool_state: Res<DrawToolState>,
    draw_state: Res<DrawState>,
    mouse_pos: Res<MousePos>,
    hovered_elem: Res<HoveredDrawElement>,
) {
    let Some(mouse_pos) = mouse_pos.0 else {
        return;
    };

    if let Some(vtx) = hovered_elem.0.as_kind::<Vertex>() {
        gizmos.circle_2d(
            Isometry2d::from_translation(draw_state.vertices[&vtx].pos),
            6.,
            Color::linear_rgb(1., 0.2, 0.2),
        );
    }

    let hovered_vtx_or_mouse_pos = match hovered_elem.0.as_kind::<Vertex>() {
        Some(vtx) => draw_state.vertices[&vtx].pos,
        None => mouse_pos,
    };

    match &*tool_state {
        DrawToolState::PlaceVertex(tool_state) => {
            if let Some(pos) = &tool_state.current_placement {
                pos.render_gizmo(&mut gizmos);
            }
        }
        DrawToolState::Wall(tool_state) => {
            if let Some(start) = tool_state.start {
                let start_pos = draw_state.vertices[&start].pos;
                let end_pos = hovered_vtx_or_mouse_pos;

                Wall {
                    start: start_pos,
                    end: end_pos,
                    kind: tool_state.kind,
                    destructable_segment_count: tool_state.destructable_segment_count,
                }
                .render_gizmo(&mut gizmos);
            }
        }
        DrawToolState::Shape(tool_state) => match tool_state.kind.clone() {
            ShapeKind::RectangleByDiagonal { start, skew_angle } => {
                if let Some(start) = start {
                    let start_pos = draw_state.vertices[&start].pos;
                    let end_pos = hovered_vtx_or_mouse_pos;

                    Rect {
                        start: start_pos,
                        end: end_pos,
                        skew: skew_angle,
                        height: tool_state.height,
                    }
                    .render_gizmo(&mut gizmos);
                }
            }
            ShapeKind::RectangleAxisAligned { start } => {
                if let Some(start) = start {
                    let start_pos = draw_state.vertices[&start].pos;
                    let end_pos = hovered_vtx_or_mouse_pos;
                    Rect::axis_aligned(start_pos, end_pos, tool_state.height)
                        .render_gizmo(&mut gizmos);
                }
            }
            ShapeKind::CircleFromThreePoints { first_two } => {
                if first_two.len() == 2 {
                    let a = draw_state.vertices[&first_two[0]].pos;
                    let b = draw_state.vertices[&first_two[1]].pos;
                    let end = hovered_vtx_or_mouse_pos;

                    CircleByThreePoints {
                        points: [a, b, end],
                        height: tool_state.height,
                    }
                    .render_gizmo(&mut gizmos);
                }
            }
        },
        DrawToolState::Door(tool_state) => {
            if let Some(hovered_wall) = hovered_elem.0.as_kind::<Wall>() {
                let wall = Wall::get_resolved(&draw_state, hovered_wall);
                let center = mouse_pos
                    .distance_to_line(wall.start, wall.end, false, false)
                    .nearest_pt;

                DoorResolved {
                    wall,
                    center,
                    kind: tool_state.kind.clone(),
                    pixels_per_meter: draw_state.pixels_per_meter(),
                }
                .render_gizmo(&mut gizmos);
            }
        }
        DrawToolState::Hatch(_tool_state) => {
            let top_left = hovered_vtx_or_mouse_pos;

            HatchResolved {
                top_left,
                pixels_per_meter: draw_state.pixels_per_meter(),
            }
            .render_gizmo(&mut gizmos);
        }
        DrawToolState::ScaleReference(tool_state) => {
            if let Some(start) = tool_state.start {
                let start_pos = draw_state.vertices[&start].pos;
                let end_pos = hovered_vtx_or_mouse_pos;

                ScaleReference {
                    endpoints: [start_pos, end_pos],
                    meters: tool_state.meters,
                }
                .render_gizmo(&mut gizmos_scale_ref);
            }
        }
    }
}

fn change_selected_draw_tool(
    mut tool_state: ResMut<DrawToolState>,
    keyboard: Res<ButtonInput<KeyCode>>,
) {
    if keyboard.just_pressed(KeyCode::Digit1) {
        *tool_state = DrawToolState::PlaceVertex(PlaceVertexToolState::default());
    }
    if keyboard.just_pressed(KeyCode::Digit2) {
        *tool_state = DrawToolState::Wall(WallToolState::default());
    }
    if keyboard.just_pressed(KeyCode::Digit3) {
        *tool_state = DrawToolState::Shape(ShapeToolState::default());
    }
    if keyboard.just_pressed(KeyCode::Digit4) {
        *tool_state = DrawToolState::Door(DoorToolState::default());
    }
    if keyboard.just_pressed(KeyCode::Digit5) {
        *tool_state = DrawToolState::Hatch(HatchToolState::default());
    }
    if keyboard.just_pressed(KeyCode::Digit0) {
        *tool_state = DrawToolState::ScaleReference(ScaleReferenceToolState::default());
    }
}

fn draw_tool_update(
    mut tool_state: ResMut<DrawToolState>,
    mut draw_state: ResMut<DrawState>,
    mouse_pos: Res<MousePos>,
    hovered_element: Res<HoveredDrawElement>,
    mouse_button: Res<ButtonInput<MouseButton>>,
    keyboard: Res<ButtonInput<KeyCode>>,
    time: Res<Time>,
) {
    let Some(mouse_pos) = mouse_pos.0 else {
        return;
    };

    let just_clicked = mouse_button.just_pressed(MouseButton::Left);

    match &mut *tool_state {
        DrawToolState::PlaceVertex(tool_state) => {
            if let Some(prev_pt) = tool_state.prev_point
                && !draw_state.vertices.contains_key(&prev_pt)
            {
                tool_state.prev_point = None;
            }

            enum Constraint {
                AngleSnapping { snap: f32, from_pt: VertexId },
                IntersectionOfTwo { take_coords: [VertexId; 2] },
                None,
            }

            let selection = draw_state.selection_as::<Vertex>();

            let selected_pt_or_prev = if selection.len() == 1 {
                Some(selection[0])
            } else if let Some(prev_pt) = tool_state.prev_point {
                Some(prev_pt)
            } else {
                None
            };

            let constraint = if let Some(from_pt) = selected_pt_or_prev
                && keyboard.pressed(KeyCode::ControlLeft)
            {
                Constraint::AngleSnapping {
                    snap: 22.5f32.to_radians(),
                    from_pt,
                }
            } else if selection.len() == 2 {
                Constraint::IntersectionOfTwo {
                    take_coords: selection
                        .try_into()
                        .expect("There should be 2 selected vertices"),
                }
            } else {
                Constraint::None
            };

            let pos = match constraint {
                Constraint::AngleSnapping { snap, from_pt } => {
                    let from_pt = draw_state.vertices[&from_pt].clone();
                    let (dir, dist) = (mouse_pos - from_pt.pos).normalize_and_length();
                    let angle = dir.to_angle();
                    let angle_snapped = (angle / snap).round() * snap;

                    from_pt.pos + Vec2::from_angle(angle_snapped) * dist
                }
                Constraint::IntersectionOfTwo { take_coords } => {
                    let candidates: [Vec2; 2] = std::array::from_fn(|idx| {
                        let take_x = draw_state.vertices[&take_coords[idx]].pos;
                        let take_y = draw_state.vertices[&take_coords[1 - idx]].pos;
                        vec2(take_x.x, take_y.y)
                    });
                    candidates
                        .into_iter()
                        .min_by_key(|x| OrderedFloat(x.distance_squared(mouse_pos)))
                        .unwrap()
                }
                Constraint::None => mouse_pos,
            };

            tool_state.current_placement = Some(Vertex { pos });

            if let Some(vtx) = tool_state.current_placement.clone()
                && just_clicked
            {
                let id = VertexId {
                    floor: draw_state.curr_floor,
                    id: Uuid::new_v4(),
                };
                draw_state.vertices.insert(id, vtx);
                draw_state.selection.clear();
                draw_state
                    .prev_actions
                    .push(PrevDrawAction::PlaceObject(DrawElementId::Vertex(id)));

                tool_state.prev_point = Some(id);
            }
        }
        DrawToolState::Wall(tool_state) => {
            if keyboard.just_pressed(KeyCode::KeyR) {
                tool_state.kind = WallKind::Indestructable;
            } else if keyboard.just_pressed(KeyCode::KeyT) {
                tool_state.kind = WallKind::Destructable;
            } else if keyboard.just_pressed(KeyCode::KeyY) {
                tool_state.kind = WallKind::Half;
            }

            if keyboard.just_pressed(KeyCode::Equal) {
                tool_state.destructable_segment_count =
                    tool_state.destructable_segment_count.saturating_add(1);
            }
            if keyboard.just_pressed(KeyCode::Minus) {
                tool_state.destructable_segment_count =
                    (tool_state.destructable_segment_count.get() - 1)
                        .try_into()
                        .unwrap_or(non_zero_u8_one());
            }

            if let Some(vtx) = hovered_element.0.as_kind::<Vertex>()
                && just_clicked
            {
                match tool_state.start {
                    Some(start) => {
                        let wall = Wall {
                            start,
                            end: vtx,
                            kind: tool_state.kind,
                            destructable_segment_count: tool_state.destructable_segment_count,
                        };
                        let id = WallId {
                            floor: draw_state.curr_floor,
                            id: Uuid::new_v4(),
                        };
                        draw_state.walls.insert(id, wall);
                        draw_state.selection.clear();
                        draw_state
                            .prev_actions
                            .push(PrevDrawAction::PlaceObject(DrawElementId::Wall(id)));

                        tool_state.start = None;
                        tool_state.destructable_segment_count = non_zero_u8_one();
                    }
                    None => tool_state.start = Some(vtx),
                }
            }
        }
        DrawToolState::Shape(tool_state) => {
            if keyboard.just_pressed(KeyCode::KeyR) {
                tool_state.kind = ShapeKind::RectangleAxisAligned { start: None };
            } else if keyboard.just_pressed(KeyCode::KeyT) {
                tool_state.kind = ShapeKind::RectangleByDiagonal {
                    start: None,
                    skew_angle: 1.,
                };
            } else if keyboard.just_pressed(KeyCode::KeyY) {
                tool_state.kind = ShapeKind::CircleFromThreePoints { first_two: vec![] };
            }

            if keyboard.just_pressed(KeyCode::BracketRight) {
                tool_state.height = ShapeHeight::Full;
            }
            if keyboard.just_pressed(KeyCode::BracketLeft) {
                tool_state.height = ShapeHeight::Half;
            }

            match &mut tool_state.kind {
                ShapeKind::RectangleByDiagonal { start, skew_angle } => {
                    let skew_change_speed = if keyboard.pressed(KeyCode::ShiftLeft) {
                        0.05
                    } else {
                        0.75
                    };
                    if keyboard.pressed(KeyCode::Equal) {
                        *skew_angle += skew_change_speed * time.delta_secs();
                    }
                    if keyboard.pressed(KeyCode::Minus) {
                        *skew_angle -= skew_change_speed * time.delta_secs();
                    }
                    *skew_angle = skew_angle.clamp(0., PI);

                    if let Some(vtx) = hovered_element.0.as_kind::<Vertex>()
                        && just_clicked
                    {
                        match *start {
                            Some(start_vtx) => {
                                let rect = Rect {
                                    start: start_vtx,
                                    end: vtx,
                                    skew: *skew_angle,
                                    height: tool_state.height,
                                };
                                let id = RectId {
                                    floor: draw_state.curr_floor,
                                    id: Uuid::new_v4(),
                                };
                                draw_state.rectangles.insert(id, rect);
                                draw_state.selection.clear();
                                draw_state
                                    .prev_actions
                                    .push(PrevDrawAction::PlaceObject(DrawElementId::Rect(id)));

                                *start = None;
                            }
                            None => *start = Some(vtx),
                        }
                    }
                }
                ShapeKind::RectangleAxisAligned { start } => {
                    if let Some(vtx) = hovered_element.0.as_kind::<Vertex>()
                        && just_clicked
                    {
                        match *start {
                            Some(start_vtx) => {
                                let skew = Rect::axis_aligned(
                                    draw_state.vertices[&start_vtx].pos,
                                    draw_state.vertices[&vtx].pos,
                                    tool_state.height,
                                )
                                .skew;
                                let rect = Rect {
                                    start: start_vtx,
                                    end: vtx,
                                    skew,
                                    height: tool_state.height,
                                };
                                let id = RectId {
                                    floor: draw_state.curr_floor,
                                    id: Uuid::new_v4(),
                                };
                                draw_state.rectangles.insert(id, rect);
                                draw_state.selection.clear();
                                draw_state
                                    .prev_actions
                                    .push(PrevDrawAction::PlaceObject(DrawElementId::Rect(id)));

                                *start = None;
                            }
                            None => *start = Some(vtx),
                        }
                    }
                }
                ShapeKind::CircleFromThreePoints { first_two } => {
                    if let Some(vtx) = hovered_element.0.as_kind::<Vertex>()
                        && just_clicked
                    {
                        first_two.push(vtx);
                        if first_two.len() > 2 {
                            if let Some(_) = Circle::from_three_points(
                                first_two
                                    .iter()
                                    .map(|vtx| draw_state.vertices[vtx].pos)
                                    .collect::<Vec<_>>()
                                    .try_into()
                                    .unwrap(),
                            ) {
                                let id = CircleByThreePointsId {
                                    floor: draw_state.curr_floor,
                                    id: Uuid::new_v4(),
                                };
                                draw_state.circles_by_three_points.insert(
                                    id,
                                    CircleByThreePoints {
                                        points: first_two.clone().try_into().unwrap(),
                                        height: tool_state.height,
                                    },
                                );
                                draw_state.selection.clear();
                                first_two.clear();
                            }
                        }
                    }
                }
            }
        }
        DrawToolState::Door(tool_state) => {
            if keyboard.just_pressed(KeyCode::KeyR) {
                tool_state.kind = DoorKind::Single;
            } else if keyboard.just_pressed(KeyCode::KeyT) {
                tool_state.kind = DoorKind::Double;
            } else if keyboard.just_pressed(KeyCode::KeyY) {
                tool_state.kind = DoorKind::SingleWindow;
            } else if keyboard.just_pressed(KeyCode::KeyU) {
                tool_state.kind = DoorKind::DoubleWindow;
            }

            if let Some(wall_id) = hovered_element.0.as_kind::<Wall>()
                && just_clicked
            {
                let id = DoorId {
                    floor: draw_state.curr_floor,
                    id: Uuid::new_v4(),
                };

                let wall = Wall::get_resolved(&draw_state, wall_id);
                let center = mouse_pos
                    .distance_to_line(wall.start, wall.end, false, false)
                    .nearest_pt;

                let door = Door {
                    wall: wall_id,
                    center,
                    kind: tool_state.kind.clone(),
                };
                draw_state.doors.insert(id, door);
                draw_state.selection.clear();
            }
        }
        DrawToolState::Hatch(_tool_state) => {
            if let Some(vtx) = hovered_element.0.as_kind::<Vertex>()
                && just_clicked
            {
                let id = HatchId {
                    floor: draw_state.curr_floor,
                    id: Uuid::new_v4(),
                };

                let hatch = Hatch { top_left: vtx };
                draw_state.hatches.insert(id, hatch);
                draw_state.selection.clear();
            }
        }
        DrawToolState::ScaleReference(tool_state) => {
            let delta = if keyboard.pressed(KeyCode::ShiftLeft) {
                1.
            } else {
                10.
            };

            if keyboard.just_pressed(KeyCode::Equal) {
                tool_state.meters += delta;
            }
            if keyboard.just_pressed(KeyCode::Minus) {
                tool_state.meters -= delta;
            }

            tool_state.meters = tool_state.meters.max(0.);

            if let Some(vtx) = hovered_element.0.as_kind::<Vertex>()
                && just_clicked
            {
                match tool_state.start {
                    Some(start) => {
                        let scale_ref = ScaleReference {
                            endpoints: [start, vtx],
                            meters: tool_state.meters,
                        };
                        let id = ScaleReferenceId {
                            floor: draw_state.curr_floor,
                        };
                        draw_state.scale_reference = Some((id, scale_ref));
                        draw_state.selection.clear();
                        draw_state.prev_actions.push(PrevDrawAction::PlaceObject(
                            DrawElementId::ScaleReference(id),
                        ));

                        tool_state.start = None;
                    }
                    None => tool_state.start = Some(vtx),
                }
            }
        }
    }
}

fn handle_undo(
    mut tool_state: ResMut<DrawToolState>,
    mut draw_state: ResMut<DrawState>,
    keyboard: Res<ButtonInput<KeyCode>>,
) {
    if keyboard.pressed(KeyCode::ControlLeft) && keyboard.just_pressed(KeyCode::KeyZ) {
        let Some(prev_action) = draw_state.prev_actions.pop() else {
            return;
        };

        match prev_action {
            PrevDrawAction::PlaceObject(id) => draw_state.remove_element(id),
        }
    }
}

fn update_selection(
    mut draw_state: ResMut<DrawState>,
    mouse_button: Res<ButtonInput<MouseButton>>,
    hovered_elem: Res<HoveredDrawElement>,
) {
    if mouse_button.just_pressed(MouseButton::Right) {
        if let Some(hovered) = hovered_elem.0 {
            if !draw_state.selection.insert(hovered) {
                draw_state.selection.remove(&hovered);
            }
        }
    }
}

fn handle_delete_selection(
    mut draw_state: ResMut<DrawState>,
    mut tool_state: ResMut<DrawToolState>,
    keyboard: Res<ButtonInput<KeyCode>>,
) {
    if keyboard.just_pressed(KeyCode::Delete) {
        for id in draw_state.selection.clone() {
            draw_state.remove_element(id);
        }
        match &mut *tool_state {
            DrawToolState::PlaceVertex(tool_state) => tool_state.prev_point = None,
            DrawToolState::Wall(tool_state) => tool_state.start = None,
            DrawToolState::Shape(tool_state) => match &mut tool_state.kind {
                ShapeKind::RectangleByDiagonal {
                    start,
                    skew_angle: _,
                } => *start = None,
                ShapeKind::RectangleAxisAligned { start } => *start = None,
                ShapeKind::CircleFromThreePoints { first_two } => *first_two = vec![],
            },
            DrawToolState::Door(_tool_state) => (),
            DrawToolState::Hatch(_tool_state) => (),
            DrawToolState::ScaleReference(tool_state) => tool_state.start = None,
        }
    }
}

fn handle_saving(
    draw_state: Res<DrawState>,
    keyboard: Res<ButtonInput<KeyCode>>,
    params: Res<MapEditorParameters>,
) {
    if keyboard.just_pressed(KeyCode::KeyS) && keyboard.pressed(KeyCode::ControlLeft) {
        let dir = format!("projects/{}", params.project_name);
        draw_state.save_and_render(&dir, &dir)
    }
}

fn change_floor(
    mut draw_state: ResMut<DrawState>,
    mut tool_state: ResMut<DrawToolState>,
    keyboard: Res<ButtonInput<KeyCode>>,
) {
    let prev_floor = draw_state.curr_floor;
    if keyboard.just_pressed(KeyCode::Period) {
        draw_state.curr_floor =
            (draw_state.curr_floor + 1).clamp(0, draw_state.floor_names.len() - 1);
    }
    if keyboard.just_pressed(KeyCode::Comma) {
        draw_state.curr_floor = draw_state.curr_floor.saturating_sub(1);
    }

    if draw_state.curr_floor != prev_floor {
        draw_state.selection.clear();
        match &mut *tool_state {
            DrawToolState::PlaceVertex(tool_state) => tool_state.prev_point = None,
            DrawToolState::Wall(tool_state) => tool_state.start = None,
            DrawToolState::Shape(tool_state) => match &mut tool_state.kind {
                ShapeKind::RectangleByDiagonal {
                    start,
                    skew_angle: _,
                } => *start = None,
                ShapeKind::RectangleAxisAligned { start } => *start = None,
                ShapeKind::CircleFromThreePoints { first_two } => first_two.clear(),
            },
            DrawToolState::Door(_tool_state) => (),
            DrawToolState::Hatch(_tool_state) => (),
            DrawToolState::ScaleReference(tool_state) => {
                tool_state.start = None;
                tool_state.meters = 0.;
            }
        }
    }
}
