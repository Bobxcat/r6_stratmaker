use std::{collections::HashMap, fmt::Display};

use fjall::KeyspaceCreateOptions;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::database_versions::{DBUpgrader, v0};

#[derive(Debug, Clone, Copy)]
pub enum DBKeyspaceId {
    Users,
    Strats,
}

impl DBKeyspaceId {
    pub fn name(self) -> &'static str {
        match self {
            DBKeyspaceId::Users => "users",
            DBKeyspaceId::Strats => "strategies",
        }
    }
}

pub trait DBKeyspace {
    type Key: Serialize + for<'a> Deserialize<'a> + Send;
    type Entry: Default + Serialize + for<'a> Deserialize<'a> + Send + 'static;

    fn keyspace_id() -> DBKeyspaceId;
}

pub struct UsersKeyspace;
impl DBKeyspace for UsersKeyspace {
    type Key = Username;

    type Entry = UsersEntry;

    fn keyspace_id() -> DBKeyspaceId {
        DBKeyspaceId::Users
    }
}

pub struct StratsKeyspace;
impl DBKeyspace for StratsKeyspace {
    type Key = StratId;

    type Entry = StratEntry;

    fn keyspace_id() -> DBKeyspaceId {
        DBKeyspaceId::Strats
    }
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Username(pub String);

impl Display for Username {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        Display::fmt(&self.0, f)
    }
}

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct UsersEntry {
    pub strats: Vec<StratId>,
}

#[derive(Deserialize, Serialize, Debug, Default, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
pub struct StratId(pub Uuid);

impl StratId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn to_string(&self) -> String {
        format!("{}", self.0)
    }

    pub fn from_str(input: &str) -> Result<Self, uuid::Error> {
        Ok(Self(Uuid::try_parse(input)?))
    }
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct DrawPath {
    pub points: Vec<Point>,
    pub color: Color,
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct Arrow {
    pub start: Point,
    pub end: Point,
    pub color: Color,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub enum IconKind {
    TeamOperator { teammate_idx: u32 },
    TeamAbility { teammate_idx: u32 },
    TeamUtility { teammate_idx: u32 },
    FreeOperator { operator: String },
    FreeAbility { ability: String },
    FreeUtility { util: String },

    Reinforcement,
    Defuser,
    Barricade,

    RunnableRotate,
    FootHole,
    HeadHole,
    VaultHole,
}

impl Default for IconKind {
    fn default() -> Self {
        IconKind::TeamOperator { teammate_idx: 0 }
    }
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct PlacedIcon {
    pub pos: Point,
    pub kind: IconKind,
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct PhaseFloor {
    pub draw_paths: HashMap<String, DrawPath>,
    pub arrows: HashMap<String, Arrow>,
    pub icons: HashMap<String, PlacedIcon>,
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct StratPhase {
    pub phase_name: String,
    pub floors: Vec<PhaseFloor>,
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct Color {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Teammate {
    pub operator: String,
    pub util: String,
    pub color: Color,
}

impl Default for Teammate {
    fn default() -> Self {
        Self {
            operator: "ace".into(),
            util: "".into(),
            color: Color::default(),
        }
    }
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct StratEntry {
    pub strat_name: String,
    pub map: String,
    pub teammates: Vec<Teammate>,
    pub phases: HashMap<String, StratPhase>,
    pub phase_order: Vec<String>,
}

pub struct UpgradeV0ToV1;
impl UpgradeV0ToV1 {
    fn upgrade_color(old: v0::Color) -> Color {
        Color {
            r: old.r,
            g: old.g,
            b: old.b,
        }
    }

    fn upgrade_point(old: v0::Point) -> Point {
        Point { x: old.x, y: old.y }
    }

    fn upgrade_floor(old: v0::PhaseFloor) -> PhaseFloor {
        PhaseFloor {
            draw_paths: old
                .draw_paths
                .into_iter()
                .map(|(id, path)| {
                    (
                        id,
                        DrawPath {
                            points: path.points.into_iter().map(Self::upgrade_point).collect(),
                            color: Self::upgrade_color(path.color),
                        },
                    )
                })
                .collect(),
            arrows: old
                .arrows
                .into_iter()
                .map(|(id, path)| {
                    (
                        id,
                        Arrow {
                            start: Self::upgrade_point(path.start),
                            end: Self::upgrade_point(path.end),
                            color: Self::upgrade_color(path.color),
                        },
                    )
                })
                .collect(),
            icons: old
                .icons
                .into_iter()
                .map(|(id, icon)| {
                    (
                        id,
                        PlacedIcon {
                            pos: Self::upgrade_point(icon.pos),
                            kind: match icon.kind {
                                v0::IconKind::TeamOperator { teammate_idx } => {
                                    IconKind::TeamOperator { teammate_idx }
                                }
                                v0::IconKind::TeamAbility { teammate_idx } => {
                                    IconKind::TeamAbility { teammate_idx }
                                }
                                v0::IconKind::TeamUtility { teammate_idx } => {
                                    IconKind::TeamUtility { teammate_idx }
                                }
                                v0::IconKind::FreeOperator { operator } => {
                                    IconKind::FreeOperator { operator }
                                }
                                v0::IconKind::FreeAbility { ability } => {
                                    IconKind::FreeAbility { ability }
                                }
                                v0::IconKind::FreeUtility { util } => {
                                    IconKind::FreeUtility { util }
                                }
                                v0::IconKind::Reinforcement => IconKind::Reinforcement,
                                v0::IconKind::Defuser => IconKind::Defuser,
                                v0::IconKind::Barricade => IconKind::Barricade,
                                v0::IconKind::RunnableRotate => IconKind::RunnableRotate,
                                v0::IconKind::FootHole => IconKind::FootHole,
                                v0::IconKind::HeadHole => IconKind::HeadHole,
                                v0::IconKind::VaultHole => IconKind::VaultHole,
                            },
                        },
                    )
                })
                .collect(),
        }
    }
}

impl DBUpgrader for UpgradeV0ToV1 {
    fn upgrade(db_v0: &fjall::Database, db_v1: &fjall::Database) -> anyhow::Result<()> {
        let mut v1_batch = db_v1.batch();

        let v0_users = db_v0.keyspace(
            v0::DBKeyspaceId::Users.name(),
            KeyspaceCreateOptions::default,
        )?;
        let v0_strats = db_v0.keyspace(
            v0::DBKeyspaceId::Strats.name(),
            KeyspaceCreateOptions::default,
        )?;

        let v1_users =
            db_v1.keyspace(DBKeyspaceId::Users.name(), KeyspaceCreateOptions::default)?;
        let v1_strats =
            db_v1.keyspace(DBKeyspaceId::Strats.name(), KeyspaceCreateOptions::default)?;

        for v0_user in v0_users.iter() {
            let (v0_key, v0_val) = v0_user.into_inner()?;
            let v0_key =
                serde_json::from_slice::<<v0::UsersKeyspace as v0::DBKeyspace>::Key>(&v0_key)?;
            let v0_val =
                serde_json::from_slice::<<v0::UsersKeyspace as v0::DBKeyspace>::Entry>(&v0_val)?;

            let v1_key = Username(v0_key.0);
            let v1_val = UsersEntry {
                strats: v0_val.strats.into_iter().map(|s| StratId(s.0)).collect(),
            };

            v1_batch.insert(
                &v1_users,
                serde_json::to_vec(&v1_key)?,
                serde_json::to_vec(&v1_val)?,
            );
        }

        for v0_strat in v0_strats.iter() {
            let (v0_key, v0_val) = v0_strat.into_inner()?;
            let v0_key =
                serde_json::from_slice::<<v0::StratsKeyspace as v0::DBKeyspace>::Key>(&v0_key)?;
            let v0_val =
                serde_json::from_slice::<<v0::StratsKeyspace as v0::DBKeyspace>::Entry>(&v0_val)?;

            let mut v1_phases = HashMap::new();
            let mut v1_phase_order = Vec::new();

            for v0_phase in v0_val.phases {
                let v1_phase = StratPhase {
                    phase_name: v0_phase.phase_name,
                    floors: v0_phase
                        .floors
                        .into_iter()
                        .map(|f| Self::upgrade_floor(f))
                        .collect(),
                };

                let id = Uuid::new_v4().to_string();
                v1_phases.insert(id.clone(), v1_phase);
                v1_phase_order.push(id);
            }

            let v1_key = StratId(v0_key.0);
            let v1_val = StratEntry {
                strat_name: v0_val.strat_name,
                map: v0_val.map,
                teammates: v0_val
                    .teammates
                    .into_iter()
                    .map(|t| Teammate {
                        operator: t.operator,
                        util: t.util,
                        color: Self::upgrade_color(t.color),
                    })
                    .collect(),
                phases: v1_phases,
                phase_order: v1_phase_order,
            };

            v1_batch.insert(
                &v1_strats,
                serde_json::to_vec(&v1_key)?,
                serde_json::to_vec(&v1_val)?,
            );
        }

        v1_batch.commit()?;

        Ok(())
    }
}
