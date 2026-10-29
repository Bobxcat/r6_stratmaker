use protobuf::{MessageField, SpecialFields};

use crate::{database_versions::curr::*, primary};

pub trait ProtoConvert {
    type Proto;

    fn from_proto(proto: Self::Proto) -> Self;
    fn to_proto(self) -> Self::Proto;
}

impl ProtoConvert for Point {
    type Proto = primary::Point;
    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            x: proto.x,
            y: proto.y,
        }
    }
    fn to_proto(self) -> Self::Proto {
        primary::Point {
            x: self.x,
            y: self.y,
            special_fields: SpecialFields::new(),
        }
    }
}

impl ProtoConvert for DrawPath {
    type Proto = primary::DrawPath;

    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            points: proto.points.into_iter().map(Point::from_proto).collect(),
            color: Color::from_proto(proto.color.unwrap()),
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            points: self.points.into_iter().map(Point::to_proto).collect(),
            color: MessageField::some(self.color.to_proto()),
            special_fields: SpecialFields::new(),
        }
    }
}

impl ProtoConvert for Arrow {
    type Proto = primary::Arrow;

    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            start: Point::from_proto(proto.start.unwrap()),
            end: Point::from_proto(proto.end.unwrap()),
            color: Color::from_proto(proto.color.unwrap()),
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            start: MessageField::some(self.start.to_proto()),
            end: MessageField::some(self.end.to_proto()),
            color: MessageField::some(self.color.to_proto()),
            special_fields: SpecialFields::new(),
        }
    }
}

impl ProtoConvert for PlacedIcon {
    type Proto = primary::Icon;

    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            pos: Point::from_proto(proto.pos.unwrap()),
            kind: match proto.IconKind.unwrap() {
                primary::icon::IconKind::TeamOperator(team_operator) => IconKind::TeamOperator {
                    teammate_idx: team_operator.teammate_idx,
                },
                primary::icon::IconKind::TeamAbility(team_ability) => IconKind::TeamAbility {
                    teammate_idx: team_ability.teammate_idx,
                },
                primary::icon::IconKind::TeamUtility(team_utility) => IconKind::TeamUtility {
                    teammate_idx: team_utility.teammate_idx,
                },
                primary::icon::IconKind::FreeOperator(free_operator) => IconKind::FreeOperator {
                    operator: free_operator.operator,
                },
                primary::icon::IconKind::FreeAbility(free_ability) => IconKind::FreeAbility {
                    ability: free_ability.ability,
                },
                primary::icon::IconKind::FreeUtility(free_utility) => IconKind::FreeUtility {
                    util: free_utility.util,
                },
                primary::icon::IconKind::Reinforcement(_) => IconKind::Reinforcement,
                primary::icon::IconKind::Defuser(_) => IconKind::Defuser,
                primary::icon::IconKind::RunnableRotate(_) => IconKind::RunnableRotate,
                primary::icon::IconKind::FootHole(_) => IconKind::FootHole,
                primary::icon::IconKind::HeadHole(_) => IconKind::HeadHole,
                primary::icon::IconKind::VaultHole(_) => IconKind::VaultHole,
                primary::icon::IconKind::Barricade(_) => IconKind::Barricade,
            },
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            pos: MessageField::some(self.pos.to_proto()),
            IconKind: Some(match self.kind {
                IconKind::TeamOperator { teammate_idx } => {
                    primary::icon::IconKind::TeamOperator(primary::icon::TeamOperator {
                        teammate_idx,
                        special_fields: SpecialFields::new(),
                    })
                }
                IconKind::TeamAbility { teammate_idx } => {
                    primary::icon::IconKind::TeamAbility(primary::icon::TeamAbility {
                        teammate_idx,
                        special_fields: SpecialFields::new(),
                    })
                }
                IconKind::TeamUtility { teammate_idx } => {
                    primary::icon::IconKind::TeamUtility(primary::icon::TeamUtility {
                        teammate_idx,
                        special_fields: SpecialFields::new(),
                    })
                }
                IconKind::FreeOperator { operator } => {
                    primary::icon::IconKind::FreeOperator(primary::icon::FreeOperator {
                        operator,
                        special_fields: SpecialFields::new(),
                    })
                }
                IconKind::FreeAbility { ability } => {
                    primary::icon::IconKind::FreeAbility(primary::icon::FreeAbility {
                        ability,
                        special_fields: SpecialFields::new(),
                    })
                }
                IconKind::FreeUtility { util } => {
                    primary::icon::IconKind::FreeUtility(primary::icon::FreeUtility {
                        util,
                        special_fields: SpecialFields::new(),
                    })
                }
                IconKind::Reinforcement => {
                    primary::icon::IconKind::Reinforcement(primary::icon::Reinforcement {
                        special_fields: SpecialFields::new(),
                    })
                }
                IconKind::Defuser => primary::icon::IconKind::Defuser(primary::icon::Defuser {
                    special_fields: SpecialFields::new(),
                }),
                IconKind::RunnableRotate => {
                    primary::icon::IconKind::RunnableRotate(primary::icon::RunnableRotate {
                        special_fields: SpecialFields::new(),
                    })
                }
                IconKind::FootHole => primary::icon::IconKind::FootHole(primary::icon::FootHole {
                    special_fields: SpecialFields::new(),
                }),
                IconKind::HeadHole => primary::icon::IconKind::HeadHole(primary::icon::HeadHole {
                    special_fields: SpecialFields::new(),
                }),
                IconKind::VaultHole => {
                    primary::icon::IconKind::VaultHole(primary::icon::VaultHole {
                        special_fields: SpecialFields::new(),
                    })
                }
                IconKind::Barricade => {
                    primary::icon::IconKind::Barricade(primary::icon::Barricade {
                        special_fields: SpecialFields::new(),
                    })
                }
            }),
            special_fields: SpecialFields::new(),
        }
    }
}

impl ProtoConvert for Color {
    type Proto = primary::Color;

    fn from_proto(color: Self::Proto) -> Self {
        Self {
            r: color.r,
            g: color.g,
            b: color.b,
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            r: self.r,
            g: self.g,
            b: self.b,
            special_fields: SpecialFields::new(),
        }
    }
}

impl ProtoConvert for PhaseFloor {
    type Proto = primary::StratFloor;

    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            draw_paths: proto
                .draw_paths
                .into_iter()
                .map(|(id, path)| (id, DrawPath::from_proto(path)))
                .collect(),
            arrows: proto
                .arrows
                .into_iter()
                .map(|(id, path)| (id, Arrow::from_proto(path)))
                .collect(),
            icons: proto
                .icons
                .into_iter()
                .map(|(id, path)| (id, PlacedIcon::from_proto(path)))
                .collect(),
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            draw_paths: self
                .draw_paths
                .into_iter()
                .map(|(id, path)| (id, path.to_proto()))
                .collect(),
            arrows: self
                .arrows
                .into_iter()
                .map(|(id, arrow)| (id, arrow.to_proto()))
                .collect(),
            icons: self
                .icons
                .into_iter()
                .map(|(id, icon)| (id, icon.to_proto()))
                .collect(),

            special_fields: SpecialFields::new(),
        }
    }
}

impl ProtoConvert for StratPhase {
    type Proto = primary::StratPhase;

    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            phase_name: proto.phase_name,
            floors: proto
                .floors
                .into_iter()
                .map(PhaseFloor::from_proto)
                .collect(),
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            phase_name: self.phase_name,
            floors: self.floors.into_iter().map(PhaseFloor::to_proto).collect(),
            special_fields: SpecialFields::new(),
        }
    }
}

impl ProtoConvert for Teammate {
    type Proto = primary::Teammate;

    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            operator: proto.operator,
            color: Color::from_proto(proto.color.unwrap()),
            util: proto.util,
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            operator: self.operator,
            color: MessageField::some(self.color.to_proto()),
            util: self.util,
            special_fields: SpecialFields::new(),
        }
    }
}

impl StratEntry {
    pub fn phase_floor_mut(&mut self, phase: &str, floor: u32) -> Option<&mut PhaseFloor> {
        self.phases
            .get_mut(phase)
            .and_then(|phase| phase.floors.get_mut(floor as usize))
    }

    pub fn to_proto(self) -> primary::StratState {
        primary::StratState {
            strat_name: self.strat_name,
            phases: self
                .phases
                .into_iter()
                .map(|(id, phase)| (id, phase.to_proto()))
                .collect(),
            phase_order: self.phase_order,
            teammates: self.teammates.into_iter().map(Teammate::to_proto).collect(),
            special_fields: SpecialFields::new(),
        }
    }

    pub fn from_proto(proto: primary::StratState, map: String) -> Self {
        Self {
            strat_name: proto.strat_name,
            map,
            teammates: proto
                .teammates
                .into_iter()
                .map(Teammate::from_proto)
                .collect(),
            phases: proto
                .phases
                .into_iter()
                .map(|(id, phase)| (id, StratPhase::from_proto(phase)))
                .collect(),
            phase_order: proto.phase_order,
        }
    }
}
