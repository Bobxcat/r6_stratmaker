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
        Arrow, DatabaseHandle, DrawPath, PhaseFloor, PlacedIcon, ProtoConvert, StratEntry, StratId,
        StratPhase, StratsKeyspace, Teammate, Username, UsersKeyspace,
    },
    protos::primary::{
        self, Client2Server, Server2Client, client2server::C2SInner, server2client::S2CInner,
    },
};

mod database;
mod protos;

const PING_PERIOD: Duration = Duration::from_secs(3);

macro_rules! context_println {
    ($($arg:tt)*) => {
        let time_str = format!(
            "[{}]",
            chrono::offset::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f")
        );
        let context_str = format!("[{}/{}:{}]", file!(), line!(), column!());
        let final_str = format!("{time_str} {context_str:<25} {}", format!($($arg)*));
        println!("{final_str}");
    };
}

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
    async fn try_next_proto(&mut self) -> anyhow::Result<Option<ReceivedMsg>>;
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
        if raw.is_ping() {
            self.send(tokio_websockets::Message::pong::<&[u8]>(&[]))
                .await?;
            return Box::pin(self.next_proto()).await;
        } else if raw.is_pong() {
            return Box::pin(self.next_proto()).await;
        }

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
    async fn try_next_proto(&mut self) -> anyhow::Result<Option<ReceivedMsg>> {
        let Some(raw) = self.next().now_or_never() else {
            return Ok(None);
        };
        let raw = raw.ok_or(anyhow!("Stream exhausted"))??;
        if raw.is_ping() {
            self.send(tokio_websockets::Message::pong::<&[u8]>(&[]))
                .await?;
            return Box::pin(self.try_next_proto()).await;
        } else if raw.is_pong() {
            return Box::pin(self.try_next_proto()).await;
        }

        let msg = Client2Server::parse_from_bytes(&raw.as_payload())?;
        let msg = msg.C2SInner.ok_or(anyhow!("Empty message!"))?;

        Ok(Some(ReceivedMsg {
            length: raw.as_payload().len(),
            msg,
        }))
    }
}

trait MpscRxExt<T> {
    fn try_recv_many(&mut self) -> Option<Vec<T>>;
}
impl<T> MpscRxExt<T> for mpsc::Receiver<T> {
    fn try_recv_many(&mut self) -> Option<Vec<T>> {
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

fn db_strat_state_to_proto(strat: StratEntry) -> primary::StratState {
    primary::StratState {
        strat_name: strat.strat_name,
        phases: strat.phases.into_iter().map(StratPhase::to_proto).collect(),
        teammates: strat
            .teammates
            .into_iter()
            .map(Teammate::to_proto)
            .collect(),
        special_fields: SpecialFields::new(),
    }
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

    match msg {
        C2SInner::LobbyDrawCommand(..) => (),
        _ => {
            context_println!(
                "[{}] received message ({}): {}",
                cl_state.username,
                bytesize::ByteSize::b(*message_length as u64),
                {
                    let mut msg_str = format!("{msg:?}");
                    msg_str.truncate(msg_str.floor_char_boundary(100));
                    msg_str
                },
            );
        }
    }

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
            context_println!("Get the info: strat={}", msg.strat_id);
            let strat_id = StratId(Uuid::try_parse(&msg.strat_id)?);

            let Some(strat) = database.get::<StratsKeyspace>(&strat_id).await? else {
                return Ok(None);
            };

            let strat_state = db_strat_state_to_proto(strat);

            cl_state
                .ws
                .send_proto(S2CInner::GetStratInfoResponse(
                    primary::GetStratInfoResponse {
                        state: MessageField::some(strat_state),
                        special_fields: SpecialFields::new(),
                    },
                ))
                .await?;
        }
        C2SInner::SaveStrat(msg) => {
            // FIXME: A client can save strats that aren't their own, and can do so while in a lobby

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
                    .map(Teammate::from_proto)
                    .collect(),
                phases: state
                    .phases
                    .into_iter()
                    .map(StratPhase::from_proto)
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
                            host_name: state.usernames[&lobby_info.host].clone(),
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
        | C2SInner::JoinLobby(_)
        | C2SInner::LobbyLoadStrat(_)
        | C2SInner::LobbyDrawCommand(_)
        | C2SInner::LobbyCreatePhase(_)
        | C2SInner::LobbySetPhaseName(_)
        | C2SInner::LobbySetTeammateLoadout(_) => return Ok(Some(msg_received)),
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
        let mut members_list_is_changed = true;

        let mut last_ping = Instant::now();

        let mut curr_strat_state: Option<StratEntry> = None;

        loop {
            tokio::task::yield_now().await;

            if last_ping.elapsed() > PING_PERIOD {
                last_ping = Instant::now();
                for cl in &mut clients {
                    let _ = cl
                        .ws
                        .send(tokio_websockets::Message::ping::<&[u8]>(&[]))
                        .await;
                }
            }

            // --- Handle clients leaving and entering ---

            // Reject disconnected clients
            for idx in (0..clients.len()).rev() {
                if clients[idx].is_disconnected {
                    members_list_is_changed = true;
                    clients.remove(idx);
                }
            }

            // Accept new clients
            if let Some(mut new_clients) = join_rx.try_recv_many()
                && new_clients.len() > 0
            {
                for cl in &mut new_clients {
                    if let Some(curr_strat_state) = &curr_strat_state {
                        let _ = cl
                            .ws
                            .send_proto(S2CInner::LobbySetCurrentStrat(
                                primary::LobbySetCurrentStrat {
                                    strat: MessageField::some(db_strat_state_to_proto(
                                        curr_strat_state.clone(),
                                    )),
                                    map: curr_strat_state.map.clone(),
                                    special_fields: SpecialFields::new(),
                                },
                            ))
                            .await;
                    }
                }
                clients.extend(new_clients);
                members_list_is_changed = true;
            }

            if members_list_is_changed {
                members_list_is_changed = false;

                if clients.is_empty() {
                    context_println!("Shutting down empty lobby");
                    let mut ss = shared_state.lock().unwrap();
                    ss.lobbies.remove(&lobby_id);
                    return Ok(());
                }

                let member_names = clients
                    .iter()
                    .map(|cl| cl.username.0.clone())
                    .collect::<Vec<_>>();

                let strat_list = {
                    let mut strats = vec![];

                    for cl in &clients {
                        if let Some(x) = database.get::<UsersKeyspace>(&cl.username).await? {
                            for strat_id in &x.strats {
                                let strat_db =
                                    database.get::<StratsKeyspace>(strat_id).await?.unwrap();
                                strats.push(primary::update_lobby_strat_list::LobbyStratInfo {
                                    strat_id: strat_id.to_string(),
                                    strat_name: strat_db.strat_name,
                                    author_name: cl.username.0.clone(),
                                    map: strat_db.map,
                                    special_fields: SpecialFields::new(),
                                });
                            }
                        }
                    }
                    strats
                };

                for cl in &mut clients {
                    let _ = cl
                        .ws
                        .send_proto(S2CInner::UpdateLobbyMembers(primary::UpdateLobbyMembers {
                            members: member_names.clone(),
                            special_fields: SpecialFields::new(),
                        }))
                        .await;

                    let _ = cl
                        .ws
                        .send_proto(S2CInner::UpdateLobbyStratList(
                            primary::UpdateLobbyStratList {
                                strats: strat_list.clone(),
                                special_fields: SpecialFields::new(),
                            },
                        ))
                        .await;
                }

                let mut ss = shared_state.lock().unwrap();
                ss.lobbies.get_mut(&lobby_id).unwrap().members =
                    clients.iter().map(|cl| cl.id).collect();
            }

            // --- Handle client messages ---
            for cl_idx in 0..clients.len() {
                loop {
                    let msg = match clients[cl_idx].ws.try_next_proto().await {
                        Ok(Some(msg)) => msg,
                        Ok(None) => break,
                        Err(e) => {
                            context_println!(
                                "[{}] Client disconnected with error `{e}`",
                                clients[cl_idx].username
                            );
                            clients[cl_idx].is_disconnected = true;
                            break;
                        }
                    };

                    if let Some(ReceivedMsg { length: _, msg }) = handle_generic_message(
                        &mut clients[cl_idx],
                        msg,
                        database.clone(),
                        shared_state.clone(),
                    )
                    .await?
                    {
                        match msg {
                            C2SInner::CreateLobby(_msg) => todo!(),
                            C2SInner::JoinLobby(_msg) => todo!(),
                            C2SInner::LobbyLoadStrat(msg) => {
                                let Ok(strat_id) = StratId::from_str(&msg.strat_id) else {
                                    continue;
                                };
                                if let Some(strat_db) =
                                    database.get::<StratsKeyspace>(&strat_id).await?
                                {
                                    for cl in &mut clients {
                                        cl.ws
                                            .send_proto(S2CInner::LobbySetCurrentStrat(
                                                primary::LobbySetCurrentStrat {
                                                    strat: MessageField::some(
                                                        db_strat_state_to_proto(strat_db.clone()),
                                                    ),
                                                    map: strat_db.map.clone(),
                                                    special_fields: SpecialFields::new(),
                                                },
                                            ))
                                            .await?;
                                    }
                                    curr_strat_state = Some(strat_db);
                                }
                            }
                            C2SInner::LobbyDrawCommand(msg) => {
                                if let Some(phase_floor) = curr_strat_state
                                    .as_mut()
                                    .and_then(|state| state.phase_floor_mut(msg.phase, msg.floor))
                                {
                                    match msg.Kind.clone().unwrap() {
                                        primary::lobby_draw_command::Kind::SetDrawPath(msg) => {
                                            phase_floor.draw_paths.insert(
                                                msg.id,
                                                DrawPath::from_proto(msg.data.unwrap_or_default()),
                                            );
                                        }
                                        primary::lobby_draw_command::Kind::SetArrow(msg) => {
                                            phase_floor.arrows.insert(
                                                msg.id,
                                                Arrow::from_proto(msg.data.unwrap_or_default()),
                                            );
                                        }
                                        primary::lobby_draw_command::Kind::SetIcon(msg) => {
                                            phase_floor.icons.insert(
                                                msg.id,
                                                PlacedIcon::from_proto(
                                                    msg.data.unwrap_or_default(),
                                                ),
                                            );
                                        }
                                        primary::lobby_draw_command::Kind::DeleteDrawPath(msg) => {
                                            phase_floor.draw_paths.remove(&msg.id);
                                        }
                                        primary::lobby_draw_command::Kind::DeleteArrow(msg) => {
                                            phase_floor.arrows.remove(&msg.id);
                                        }
                                        primary::lobby_draw_command::Kind::DeleteIcon(msg) => {
                                            phase_floor.icons.remove(&msg.id);
                                        }
                                    }

                                    // Send the draw state change to all clients other than the one that notfied us
                                    for to_send_client in 0..clients.len() {
                                        if to_send_client == cl_idx {
                                            continue;
                                        }
                                        let _ = clients[to_send_client]
                                            .ws
                                            .send_proto(S2CInner::LobbyDrawCommand(msg.clone()))
                                            .await;
                                    }
                                }
                            }
                            C2SInner::LobbyCreatePhase(msg) => {
                                if let Some(strat_state) = curr_strat_state.as_mut() {
                                    let map_meta =
                                        MapId::from_map_name(&strat_state.map).unwrap().metadata();

                                    strat_state.phases.push(StratPhase {
                                        phase_name: msg.phaseName.clone(),
                                        floors: map_meta
                                            .floors
                                            .into_iter()
                                            .map(|_| PhaseFloor {
                                                draw_paths: HashMap::new(),
                                                arrows: HashMap::new(),
                                                icons: HashMap::new(),
                                            })
                                            .collect(),
                                    });

                                    for to_send_client in 0..clients.len() {
                                        if to_send_client == cl_idx {
                                            continue;
                                        }
                                        let _ = clients[to_send_client]
                                            .ws
                                            .send_proto(S2CInner::LobbyCreatePhase(msg.clone()))
                                            .await;
                                    }
                                }
                            }
                            C2SInner::LobbySetPhaseName(msg) => {
                                if let Some(phase) = curr_strat_state
                                    .as_mut()
                                    .and_then(|strat| strat.phases.get_mut(msg.idx as usize))
                                {
                                    phase.phase_name = msg.phase_name.clone();

                                    for to_send_client in 0..clients.len() {
                                        if to_send_client == cl_idx {
                                            continue;
                                        }
                                        let _ = clients[to_send_client]
                                            .ws
                                            .send_proto(S2CInner::LobbySetPhaseName(msg.clone()))
                                            .await;
                                    }
                                }
                            }
                            C2SInner::LobbySetTeammateLoadout(msg) => {
                                if let Some(teammate) = curr_strat_state
                                    .as_mut()
                                    .and_then(|strat| strat.teammates.get_mut(msg.idx as usize))
                                {
                                    *teammate =
                                        Teammate::from_proto(msg.newLoadout.clone().unwrap());

                                    for to_send_client in 0..clients.len() {
                                        if to_send_client == cl_idx {
                                            continue;
                                        }
                                        let _ = clients[to_send_client]
                                            .ws
                                            .send_proto(S2CInner::LobbySetTeammateLoadout(
                                                msg.clone(),
                                            ))
                                            .await;
                                    }
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
                                context_println!("WARN: {msg:?} Should be handled generically",);
                            }
                        }
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
    let mut last_ping = Instant::now();

    loop {
        // Not strictly necessary since we yield whenever there's no message received
        tokio::task::yield_now().await;

        if last_ping.elapsed() > PING_PERIOD {
            last_ping = Instant::now();
            cl_state
                .ws
                .send(tokio_websockets::Message::ping::<&[u8]>(&[]))
                .await?;
        }

        // Handle message
        if let Some(msg) = cl_state
            .ws
            .try_next_proto()
            .await
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
                    | C2SInner::GetLobbyList(..)
                    | C2SInner::LobbyLoadStrat(..)
                    | C2SInner::LobbyDrawCommand(..)
                    | C2SInner::LobbyCreatePhase(..)
                    | C2SInner::LobbySetPhaseName(..)
                    | C2SInner::LobbySetTeammateLoadout(..) => {
                        context_println!("WARN: {msg:?} Should be handled generically");
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

    context_println!("[{username}] Client finished login");
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

const HOST_PUBLIC: bool = true;

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    let addr = if HOST_PUBLIC {
        "0.0.0.0:8080"
    } else {
        "127.0.0.1:8080"
    };
    let listener = TcpListener::bind(addr).await?;
    let database = DatabaseHandle::initialize().await?;

    let shared_state = SharedState {
        lobbies: HashMap::new(),
        usernames: HashMap::new(),
    };
    let shared_state = SharedStateHandle(Arc::new(Mutex::new(shared_state)));
    context_println!("Started!");

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            context_println!("TCP Connection established, attempting HTTP handshake");
            let Ok((_request, ws_stream)) = ServerBuilder::new().accept(stream).await else {
                context_println!("HTTP handshake failed...");
                continue;
            };

            context_println!("Client Accepted at {:?}", ws_stream.get_ref().peer_addr());

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
