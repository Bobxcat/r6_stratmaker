use std::time::Duration;

use anyhow::{anyhow, bail};
use fjall::{Database, Keyspace, KeyspaceCreateOptions};
use futures_util::{SinkExt, StreamExt};
use json::JsonValue;
use protobuf::{Message, SpecialFields};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio_websockets::{ServerBuilder, WebSocketStream};
use uuid::Uuid;

use crate::{
    database::{
        DatabaseHandle, StratEntry, StratId, StratPhase, StratPhaseFloor, StratsKeyspace, Username,
        UsersKeyspace,
    },
    protos::primary::{
        self, Client2Server, Server2Client, client2server::C2SInner, server2client::S2CInner,
    },
};

mod database;
mod protos;

pub struct MapMetadata {
    pub name: &'static str,
    pub floors: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MapId {
    Chalet,
    Coastline,
}

impl MapId {
    pub fn all_maps() -> &'static [MapId] {
        use MapId::*;
        &[Chalet, Coastline]
    }

    pub fn from_map_name(s: &str) -> Option<Self> {
        for map in Self::all_maps() {
            if map.metadata().name == s {
                return Some(*map);
            }
        }

        None
    }

    pub fn metadata(&self) -> &'static MapMetadata {
        match self {
            MapId::Chalet => &MapMetadata {
                name: "chalet",
                floors: &["basement", "floor_1", "floor_2", "roof"],
            },
            MapId::Coastline => &MapMetadata {
                name: "coastline",
                floors: &["floor_1", "floor_2", "roof"],
            },
        }
    }
}

pub struct ReceivedMsg {
    length: usize,
    msg: C2SInner,
}

trait WsStreamExt {
    async fn send_proto(&mut self, msg: S2CInner) -> Result<(), tokio_websockets::Error>;

    async fn next_proto(&mut self) -> anyhow::Result<ReceivedMsg>;
}

impl WsStreamExt for WebSocketStream<TcpStream> {
    async fn send_proto(&mut self, msg: S2CInner) -> Result<(), tokio_websockets::Error> {
        let msg = Server2Client {
            S2CInner: Some(msg),
            special_fields: SpecialFields::new(),
        };
        let mut buf = vec![];
        msg.write_to_vec(&mut buf);
        self.send(tokio_websockets::Message::binary(buf)).await?;
        Ok(())
    }

    async fn next_proto(&mut self) -> anyhow::Result<ReceivedMsg> {
        let raw = self
            .next()
            .await
            .ok_or(anyhow!("Message failed to be received"))??;

        let msg = Client2Server::parse_from_bytes(&raw.as_payload())?;
        let msg = msg.C2SInner.ok_or(anyhow!("Empty message!"))?;

        Ok(ReceivedMsg {
            length: raw.as_payload().len(),
            msg,
        })
    }
}

impl Server2Client {
    pub fn from_inner(x: S2CInner) -> Self {
        Self {
            S2CInner: Some(x),
            special_fields: SpecialFields::new(),
        }
    }
}

async fn accept_client(
    mut ws_stream: WebSocketStream<TcpStream>,
    database: DatabaseHandle,
) -> Result<(), anyhow::Error> {
    // Handshake
    let user = {
        // ---STEP 1: Client says "hello"
        let ReceivedMsg { length: _, msg } = ws_stream.next_proto().await?;
        let C2SInner::Hello(_) = msg else {
            bail!("Expected a `hello` message, received `{msg:?}`");
        };

        // ---STEP 2: Server says "hello_response"
        ws_stream
            .send_proto(S2CInner::HelloResponse(primary::HelloResponse::new()))
            .await?;

        // ---STEP 3: Client sends a login request
        let ReceivedMsg { length: _, msg } = ws_stream.next_proto().await?;
        let C2SInner::LoginRequest(login_request) = msg else {
            bail!("Expected a `login_request` message, received `{msg:?}`");
        };

        let user = Username(login_request.username);

        database
            .get_or_insert_default::<UsersKeyspace>(&user)
            .await?;

        // ---STEP 4: Server tells the client that the login was successful
        ws_stream
            .send_proto(S2CInner::LoginResponse(primary::LoginResponse::new()))
            .await?;

        user
    };

    println!("[{user}] Client finished login");

    // Loop
    while let Ok(ReceivedMsg {
        length: message_length,
        msg,
    }) = ws_stream.next_proto().await
    {
        println!(
            "[{user}] received message ({}): {}",
            bytesize::ByteSize::b(message_length as u64),
            {
                let mut msg_str = format!("{msg:?}");
                msg_str.truncate(msg_str.floor_char_boundary(100));
                msg_str
            },
        );
        match msg {
            C2SInner::GetStratList(_msg) => {
                let Some(user_info) = database.get::<UsersKeyspace>(&user).await? else {
                    continue;
                };

                let mut strats_response: Vec<primary::GetStratListResponseEntry> = vec![];

                for strat_id in &user_info.strats {
                    let strat_info = database.get::<StratsKeyspace>(strat_id).await?.unwrap();

                    strats_response.push(primary::GetStratListResponseEntry {
                        strat_id: strat_id.to_string(),
                        strat_name: strat_info.strat_name,
                        map: strat_info.map,
                        special_fields: SpecialFields::new(),
                    });
                }

                ws_stream
                    .send_proto(S2CInner::GetStratListResponse(
                        primary::GetStratListResponse {
                            strats: strats_response,
                            special_fields: SpecialFields::new(),
                        },
                    ))
                    .await?;
            }
            C2SInner::CreateEmptyStrat(msg) => {
                let strat_id = StratId::new();

                let mut user_info = database.get::<UsersKeyspace>(&user).await?.unwrap();
                user_info.strats.push(strat_id.clone());
                database.insert::<UsersKeyspace>(&user, &user_info).await?;

                database
                    .insert::<StratsKeyspace>(
                        &strat_id,
                        &StratEntry {
                            strat_name: "unnamed".into(),
                            map: msg.map,
                            phases: vec![],
                        },
                    )
                    .await?;

                ws_stream
                    .send_proto(S2CInner::CreateEmptyStratResponse(
                        primary::CreateEmptyStratResponse {
                            strat_id: strat_id.to_string(),
                            special_fields: SpecialFields::new(),
                        },
                    ))
                    .await?;
            }
            C2SInner::GetMapMetadata(msg) => {
                let map_id = MapId::from_map_name(&msg.map).unwrap();
                let MapMetadata { name: _, floors } = *map_id.metadata();

                ws_stream
                    .send_proto(S2CInner::GetMapMetadataResponse(
                        primary::GetMapMetadataResponse {
                            floors: floors.iter().map(|&s| String::from(s)).collect(),
                            special_fields: SpecialFields::new(),
                        },
                    ))
                    .await?;
            }
            C2SInner::GetStratInfo(msg) => {
                println!("Get the info: strat={}", msg.strat_id);
                let strat_id = StratId(Uuid::try_parse(&msg.strat_id)?);

                let Some(strat) = database.get::<StratsKeyspace>(&strat_id).await? else {
                    continue;
                };

                let state = primary::StratState {
                    strat_name: strat.strat_name,
                    phases: strat
                        .phases
                        .into_iter()
                        .map(|phase| primary::StratPhase {
                            phase_name: phase.phase_name,
                            floors: phase
                                .floors
                                .into_iter()
                                .map(|floor| primary::StratFloor {
                                    freeDrawPaths: floor
                                        .draw_paths
                                        .into_iter()
                                        .map(|path| primary::FreeDrawPath {
                                            points: path
                                                .into_iter()
                                                .map(|[x, y]| primary::Point {
                                                    x,
                                                    y,
                                                    special_fields: SpecialFields::new(),
                                                })
                                                .collect(),
                                            special_fields: SpecialFields::new(),
                                        })
                                        .collect(),
                                    special_fields: SpecialFields::new(),
                                })
                                .collect(),
                            special_fields: SpecialFields::new(),
                        })
                        .collect(),
                    special_fields: SpecialFields::new(),
                };

                ws_stream
                    .send_proto(S2CInner::GetStratInfoResponse(
                        primary::GetStratInfoResponse {
                            state: protobuf::MessageField(Some(Box::new(state))),
                            special_fields: SpecialFields::new(),
                        },
                    ))
                    .await?;
            }
            C2SInner::SaveStrat(msg) => {
                let strat_id = StratId(Uuid::try_parse(&msg.strat_id)?);
                let Some(state) = msg.state.into_option() else {
                    continue;
                };

                let Some(mut strat) = database.get::<StratsKeyspace>(&strat_id).await? else {
                    continue;
                };
                // Update strat entry...
                strat = StratEntry {
                    strat_name: state.strat_name,
                    map: strat.map,
                    phases: state
                        .phases
                        .into_iter()
                        .map(|state_phase| StratPhase {
                            phase_name: state_phase.phase_name,
                            floors: state_phase
                                .floors
                                .into_iter()
                                .map(|state_floor| StratPhaseFloor {
                                    draw_paths: state_floor
                                        .freeDrawPaths
                                        .into_iter()
                                        .map(|free_draw_path| {
                                            free_draw_path
                                                .points
                                                .into_iter()
                                                .map(|pt| [pt.x, pt.y])
                                                .collect()
                                        })
                                        .collect(),
                                    placed_icons: vec![],
                                })
                                .collect(),
                        })
                        .collect(),
                };
                // ...
                database.insert::<StratsKeyspace>(&strat_id, &strat).await?;
            }
            msg => println!("Unexpected message: `{msg:?}`",),
        }
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    let listener = TcpListener::bind("127.0.0.1:8080").await?;
    let database = DatabaseHandle::initialize().await?;

    println!("Started!");

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (_request, ws_stream) = ServerBuilder::new().accept(stream).await?;

            println!("Client Accepted at {:?}", ws_stream.get_ref().local_addr());

            let db_clone = database.clone();
            tokio::spawn(async move {
                let res = accept_client(ws_stream, db_clone).await;
                println!("Client Exited: {res:?}");
                res
            });
        }

        Ok::<_, anyhow::Error>(())
    })
    .await
    .unwrap()?;

    Ok(())
}
