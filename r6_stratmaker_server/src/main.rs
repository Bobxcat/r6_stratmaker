use std::{
    collections::HashMap,
    ops::Deref,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, anyhow, bail};
use futures_util::{FutureExt, SinkExt, StreamExt};
use protobuf::{Message, MessageField, SpecialFields};
use serde::{Deserialize, Serialize};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::mpsc,
};
use tokio_websockets::{ServerBuilder, WebSocketStream};
use uuid::Uuid;

use crate::{
    database::{
        Arrow, Color, DatabaseHandle, DrawPath, PhaseFloor, PlacedIcon, ProtoConvert, StratEntry,
        StratId, StratPhase, StratsKeyspace, Teammate, Username, UsersKeyspace,
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
    async fn send_proto(&mut self, msg: S2CInner) -> anyhow::Result<()>;

    async fn next_proto(&mut self) -> anyhow::Result<ReceivedMsg>;
    fn try_next_proto(&mut self) -> anyhow::Result<Option<ReceivedMsg>>;
}

impl WsStreamExt for WebSocketStream<TcpStream> {
    async fn send_proto(&mut self, msg: S2CInner) -> anyhow::Result<()> {
        let msg = Server2Client {
            S2CInner: Some(msg),
            special_fields: SpecialFields::new(),
        };
        let mut buf = vec![];
        msg.write_to_vec(&mut buf)?;
        self.send(tokio_websockets::Message::binary(buf)).await?;
        Ok(())
    }

    async fn next_proto(&mut self) -> anyhow::Result<ReceivedMsg> {
        let raw = self.next().await.ok_or(anyhow!("Stream exhausted"))??;

        let msg = Client2Server::parse_from_bytes(&raw.as_payload())?;
        let msg = msg.C2SInner.ok_or(anyhow!("Empty message!"))?;

        Ok(ReceivedMsg {
            length: raw.as_payload().len(),
            msg,
        })
    }

    /// ### Returns:
    /// * `Ok(Some(msg))` - There was a message immediately available
    /// * `Ok(None)` - There was no message immediately available
    /// * `Err(e)` - Websocket error or invalid message received
    fn try_next_proto(&mut self) -> anyhow::Result<Option<ReceivedMsg>> {
        let Some(raw) = self.next().now_or_never() else {
            return Ok(None);
        };
        let raw = raw.ok_or(anyhow!("Stream exhausted"))??;

        let msg = Client2Server::parse_from_bytes(&raw.as_payload())?;
        let msg = msg.C2SInner.ok_or(anyhow!("Empty message!"))?;

        Ok(Some(ReceivedMsg {
            length: raw.as_payload().len(),
            msg,
        }))
    }
}

trait MpscRxExt<T> {
    async fn try_recv_many(&mut self) -> Option<Vec<T>>;
}
impl<T> MpscRxExt<T> for mpsc::Receiver<T> {
    async fn try_recv_many(&mut self) -> Option<Vec<T>> {
        let mut v = vec![];
        loop {
            match self.try_recv() {
                Ok(x) => v.push(x),
                Err(mpsc::error::TryRecvError::Empty) => return Some(v),
                Err(mpsc::error::TryRecvError::Disconnected) => return None,
            }
        }
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClientId(pub Uuid);

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LobbyId(pub Uuid);

#[derive(Debug)]
struct LobbyInfo {
    host: ClientId,
    members: Vec<ClientId>,
    join_tx: mpsc::Sender<ClientState>,
}

#[derive(Debug)]
struct SharedState {
    /// `host -> members (incl. host)`
    pub lobbies: HashMap<LobbyId, LobbyInfo>,
    pub usernames: HashMap<ClientId, String>,
}

#[derive(Debug, Clone)]
struct SharedStateHandle(Arc<Mutex<SharedState>>);

impl Deref for SharedStateHandle {
    type Target = Arc<Mutex<SharedState>>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

struct ClientState {
    is_disconnected: bool,
    id: ClientId,
    username: Username,
    ws: WebSocketStream<TcpStream>,
}

/// ### Returns:
/// * `Ok(Some(msg))` - The received message isn't of a generic type, and wasn't handled
/// * `Ok(None)` - The received message was handled successfully
/// * `Err(e)` - An error was encountered when handling the message
async fn handle_generic_message(
    cl_state: &mut ClientState,
    msg_received: ReceivedMsg,
    database: DatabaseHandle,
    shared_state: SharedStateHandle,
) -> anyhow::Result<Option<ReceivedMsg>> {
    let ReceivedMsg {
        length: message_length,
        msg,
    } = &msg_received;
    println!(
        "[{}] received message ({}): {}",
        cl_state.username,
        bytesize::ByteSize::b(*message_length as u64),
        {
            let mut msg_str = format!("{msg:?}");
            msg_str.truncate(msg_str.floor_char_boundary(100));
            msg_str
        },
    );
    match msg {
        C2SInner::GetStratList(_msg) => {
            let Some(user_info) = database.get::<UsersKeyspace>(&cl_state.username).await? else {
                return Ok(None);
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

            cl_state
                .ws
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

            let mut user_info = database
                .get::<UsersKeyspace>(&cl_state.username)
                .await?
                .unwrap();
            user_info.strats.push(strat_id.clone());
            database
                .insert::<UsersKeyspace>(&cl_state.username, &user_info)
                .await?;

            database
                .insert::<StratsKeyspace>(
                    &strat_id,
                    &StratEntry {
                        strat_name: "unnamed".into(),
                        map: msg.map.clone(),
                        phases: vec![],
                        teammates: vec![Teammate::default(); 5],
                    },
                )
                .await?;

            cl_state
                .ws
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

            cl_state
                .ws
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
                return Ok(None);
            };

            let strat_state = primary::StratState {
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
                                drawPaths: floor
                                    .draw_paths
                                    .into_iter()
                                    .map(|(id, path)| (id, path.to_proto()))
                                    .collect(),
                                arrows: floor
                                    .arrows
                                    .into_iter()
                                    .map(|(id, arrow)| (id, arrow.to_proto()))
                                    .collect(),
                                icons: floor
                                    .icons
                                    .into_iter()
                                    .map(|(id, icon)| (id, icon.to_proto()))
                                    .collect(),

                                special_fields: SpecialFields::new(),
                            })
                            .collect(),
                        special_fields: SpecialFields::new(),
                    })
                    .collect(),
                teammates: strat
                    .teammates
                    .into_iter()
                    .map(|teammate| primary::Teammate {
                        operator: teammate.operator,
                        color: MessageField::some(teammate.color.to_proto()),
                        util: teammate.util,
                        special_fields: SpecialFields::new(),
                    })
                    .collect(),
                special_fields: SpecialFields::new(),
            };

            cl_state
                .ws
                .send_proto(S2CInner::GetStratInfoResponse(
                    primary::GetStratInfoResponse {
                        state: protobuf::MessageField(Some(Box::new(strat_state))),
                        special_fields: SpecialFields::new(),
                    },
                ))
                .await?;
        }
        C2SInner::SaveStrat(msg) => {
            let strat_id = StratId(Uuid::try_parse(&msg.strat_id).context(format!(
                "{}: {}",
                line!(),
                msg.strat_id
            ))?);
            let Some(state) = msg.state.clone().into_option() else {
                return Ok(None);
            };

            let Some(mut strat) = database.get::<StratsKeyspace>(&strat_id).await? else {
                return Ok(None);
            };

            strat = StratEntry {
                strat_name: state.strat_name,
                map: strat.map,
                teammates: state
                    .teammates
                    .into_iter()
                    .map(|teammate| Teammate {
                        operator: teammate.operator,
                        color: Color::from_proto(teammate.color.unwrap()),
                        util: teammate.util,
                    })
                    .collect(),
                phases: state
                    .phases
                    .into_iter()
                    .map(|phase| StratPhase {
                        phase_name: phase.phase_name,
                        floors: phase
                            .floors
                            .into_iter()
                            .map(|f| PhaseFloor {
                                draw_paths: f
                                    .drawPaths
                                    .into_iter()
                                    .map(|(id, path)| (id, DrawPath::from_proto(path)))
                                    .collect(),
                                arrows: f
                                    .arrows
                                    .into_iter()
                                    .map(|(id, path)| (id, Arrow::from_proto(path)))
                                    .collect(),
                                icons: f
                                    .icons
                                    .into_iter()
                                    .map(|(id, path)| (id, PlacedIcon::from_proto(path)))
                                    .collect(),
                            })
                            .collect(),
                    })
                    .collect(),
            };
            database.insert::<StratsKeyspace>(&strat_id, &strat).await?;
        }
        C2SInner::GetLobbyList(_msg) => {
            let lobbies = {
                let state = shared_state.lock().unwrap();
                state
                    .lobbies
                    .iter()
                    .map(
                        |(lobby_id, lobby_info)| primary::get_lobby_list_response::LobbyInfo {
                            id: lobby_id.0.to_string(),
                            hostName: state.usernames[&lobby_info.host].clone(),
                            special_fields: SpecialFields::new(),
                        },
                    )
                    .collect()
            };

            cl_state
                .ws
                .send_proto(S2CInner::GetLobbyListResponse(
                    primary::GetLobbyListResponse {
                        lobbies,
                        special_fields: SpecialFields::new(),
                    },
                ))
                .await?;
        }

        C2SInner::Hello(_)
        | C2SInner::LoginRequest(_)
        | C2SInner::CreateLobby(_)
        | C2SInner::JoinLobby(_) => return Ok(Some(msg_received)),
    }

    Ok(None)
}

fn lobby_loop(
    mut host: ClientState,
    database: DatabaseHandle,
    shared_state: SharedStateHandle,
) -> impl Future<Output = anyhow::Result<()>> + Send {
    async move {
        let lobby_id = LobbyId(Uuid::new_v4());

        host.ws
            .send_proto(S2CInner::CreateLobbyResponse(
                primary::CreateLobbyResponse {
                    special_fields: SpecialFields::new(),
                },
            ))
            .await?;

        host.ws
            .send_proto(S2CInner::UpdateLobbyMembers(primary::UpdateLobbyMembers {
                members: vec![host.username.0.clone()],
                special_fields: SpecialFields::new(),
            }))
            .await?;

        let mut join_rx = {
            let (join_tx, join_rx) = mpsc::channel(8);
            let lobby_info = LobbyInfo {
                host: host.id,
                members: vec![host.id],
                join_tx,
            };
            let mut ss = shared_state.lock().unwrap();
            ss.lobbies.insert(lobby_id, lobby_info);
            join_rx
        };

        let mut clients = vec![host];

        loop {
            tokio::task::yield_now().await;

            // --- Handle clients leaving and entering ---

            let mut members_list_is_updated = false;
            // Reject disconnected clients
            for idx in (0..clients.len()).rev() {
                if clients[idx].is_disconnected {
                    members_list_is_updated = true;
                    clients.remove(idx);
                }
            }

            // Accept new clients
            if let Some(new_clients) = join_rx.try_recv_many().await
                && new_clients.len() > 0
            {
                clients.extend(new_clients);
                members_list_is_updated = true;
            }

            if members_list_is_updated {
                if clients.is_empty() {
                    println!("Shutting down empty lobby");
                    return Ok(());
                }

                let member_names = clients
                    .iter()
                    .map(|cl| cl.username.0.clone())
                    .collect::<Vec<_>>();

                for cl in &mut clients {
                    cl.ws
                        .send_proto(S2CInner::UpdateLobbyMembers(primary::UpdateLobbyMembers {
                            members: member_names.clone(),
                            special_fields: SpecialFields::new(),
                        }))
                        .await?;
                }

                let mut ss = shared_state.lock().unwrap();
                ss.lobbies.get_mut(&lobby_id).unwrap().members =
                    clients.iter().map(|cl| cl.id).collect();
            }

            // --- Handle client messages ---
            for cl in &mut clients {
                match cl.ws.try_next_proto() {
                    Ok(Some(msg)) => {
                        if let Some(ReceivedMsg { length: _, msg }) =
                            handle_generic_message(cl, msg, database.clone(), shared_state.clone())
                                .await?
                        {
                            match msg {
                                C2SInner::CreateLobby(_msg) => todo!(),
                                C2SInner::JoinLobby(_msg) => todo!(),

                                C2SInner::Hello(..)
                                | C2SInner::LoginRequest(..)
                                | C2SInner::GetStratList(..)
                                | C2SInner::CreateEmptyStrat(..)
                                | C2SInner::GetMapMetadata(..)
                                | C2SInner::GetStratInfo(..)
                                | C2SInner::SaveStrat(..)
                                | C2SInner::GetLobbyList(..) => {
                                    unreachable!("{msg:?} Should be handled generically")
                                }
                            }
                        }
                    }
                    Ok(None) => (),
                    Err(e) => {
                        println!("[{}] Client disconnected with error `{e}`", cl.username);
                        cl.is_disconnected = true;
                    }
                }
            }
        }

        // Note: there's no need to ever delete the lobby except when there are *no* clients, and thus no cleanup is required
    }
}

async fn client_loop(
    mut cl_state: ClientState,
    database: DatabaseHandle,
    shared_state: SharedStateHandle,
) -> anyhow::Result<()> {
    let mut loop_interval = tokio::time::interval(Duration::from_micros(500));

    loop {
        // Not strictly necessary since we yield whenever there's no message received
        tokio::task::yield_now().await;

        // Handle message
        if let Some(msg) = cl_state
            .ws
            .try_next_proto()
            .context("Failed to receive message")?
        {
            if let Some(ReceivedMsg { length: _, msg }) =
                handle_generic_message(&mut cl_state, msg, database.clone(), shared_state.clone())
                    .await?
            {
                match msg {
                    C2SInner::CreateLobby(_msg) => {
                        tokio::spawn(lobby_loop(cl_state, database, shared_state));
                        return Ok(());
                    }
                    C2SInner::JoinLobby(msg) => {
                        let lobby_id = LobbyId(Uuid::try_parse(&msg.id).context(format!(
                            "{}: {}",
                            line!(),
                            msg.id
                        ))?);
                        let mut join_tx = None;
                        {
                            let state = shared_state.lock().unwrap();
                            if let Some(lobby) = state.lobbies.get(&lobby_id) {
                                join_tx = Some(lobby.join_tx.clone());
                            }
                        }
                        if let Some(join_tx) = join_tx {
                            cl_state
                                .ws
                                .send_proto(S2CInner::JoinLobbyResponse(
                                    primary::JoinLobbyResponse {
                                        special_fields: SpecialFields::new(),
                                    },
                                ))
                                .await?;

                            join_tx.send(cl_state).await?;

                            return Ok(());
                        }
                    }

                    C2SInner::Hello(..)
                    | C2SInner::LoginRequest(..)
                    | C2SInner::GetStratList(..)
                    | C2SInner::CreateEmptyStrat(..)
                    | C2SInner::GetMapMetadata(..)
                    | C2SInner::GetStratInfo(..)
                    | C2SInner::SaveStrat(..)
                    | C2SInner::GetLobbyList(..) => {
                        unreachable!("{msg:?} Should be handled generically")
                    }
                }
            }
        } else {
            // Sleep when there's no messages received
            // This way, we can handle bursts of messages without hogging the resources
            loop_interval.tick().await;
        }
    }
}

async fn accept_client(
    id: ClientId,
    mut ws: WebSocketStream<TcpStream>,
    database: DatabaseHandle,
    shared_state: SharedStateHandle,
) -> anyhow::Result<()> {
    // Handshake
    let username = {
        // ---STEP 1: Client says "hello"
        let ReceivedMsg { length: _, msg } = ws.next_proto().await?;
        let C2SInner::Hello(_) = msg else {
            bail!("Expected a `hello` message, received `{msg:?}`");
        };

        // ---STEP 2: Server says "hello_response"
        ws.send_proto(S2CInner::HelloResponse(primary::HelloResponse::new()))
            .await?;

        // ---STEP 3: Client sends a login request
        let ReceivedMsg { length: _, msg } = ws.next_proto().await?;
        let C2SInner::LoginRequest(login_request) = msg else {
            bail!("Expected a `login_request` message, received `{msg:?}`");
        };

        let user = Username(login_request.username);

        database
            .get_or_insert_default::<UsersKeyspace>(&user)
            .await?;

        // ---STEP 4: Server tells the client that the login was successful
        ws.send_proto(S2CInner::LoginResponse(primary::LoginResponse::new()))
            .await?;

        let mut state = shared_state.lock().unwrap();
        state.usernames.insert(id, user.0.clone());

        user
    };

    println!("[{username}] Client finished login");
    tokio::spawn(client_loop(
        ClientState {
            is_disconnected: false,
            id,
            username,
            ws,
        },
        database,
        shared_state,
    ));

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    let listener = TcpListener::bind("127.0.0.1:8080").await?;
    let database = DatabaseHandle::initialize().await?;

    let shared_state = SharedState {
        lobbies: HashMap::new(),
        usernames: HashMap::new(),
    };
    let shared_state = SharedStateHandle(Arc::new(Mutex::new(shared_state)));
    println!("Started!");

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (_request, ws_stream) = ServerBuilder::new().accept(stream).await?;

            println!("Client Accepted at {:?}", ws_stream.get_ref().local_addr());

            let db_clone = database.clone();
            let state_clone = shared_state.clone();
            tokio::spawn(async move {
                let client_handler_id = ClientId(Uuid::new_v4());
                let res =
                    accept_client(client_handler_id, ws_stream, db_clone, state_clone.clone())
                        .await;

                res
            });
        }

        Ok::<_, anyhow::Error>(())
    })
    .await
    .unwrap()?;

    Ok(())
}
