use std::{io::BufWriter, path::Path, time::Duration};

use anyhow::Context;
use fjall::{Database, Keyspace, KeyspaceCreateOptions};

use crate::{
    context_str,
    database_versions::{
        DatabaseVersion,
        curr::{DBKeyspace, DBKeyspaceId},
    },
};

async fn copy_dir_all(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(&dst)
        .await
        .context(context_str!())?;
    let mut dirs = tokio::fs::read_dir(src).await.context(context_str!())?;
    while let Some(entry) = dirs.next_entry().await.context(context_str!())? {
        let ty = entry.file_type().await.context(context_str!())?;
        if ty.is_dir() {
            Box::pin(copy_dir_all(
                entry.path(),
                dst.as_ref().join(entry.file_name()),
            ))
            .await?;
        } else {
            tokio::fs::copy(entry.path(), dst.as_ref().join(entry.file_name()))
                .await
                .context(context_str!())?;
        }
    }
    Ok(())
}

#[derive(Clone)]
pub struct DatabaseHandle {
    #[allow(unused)]
    database: Database,
    users: Keyspace,
    strategies: Keyspace,
}

impl DatabaseHandle {
    const DATABASE_PATH: &str = ".fjall_database";
    const BACKUP_PATH: &str = ".fjall_backups";
    const UPGRADE_DIR: &str = ".fjall_upgrading";

    /// ONLY CALL ONCE! Or rather, only have one instance active!
    pub async fn initialize() -> anyhow::Result<Self> {
        let database = Database::builder(Self::DATABASE_PATH).open()?;
        Self::backup_inner(database.clone())
            .await
            .context(context_str!())?;
        drop(database);

        // We ensure the database is upgraded before initializing the keyspaces (which may be incompatible with the version)
        if DatabaseVersion::from_database_path(Self::DATABASE_PATH) != DatabaseVersion::curr() {
            let upgrade_from = Path::new(Self::UPGRADE_DIR).join("from");
            let upgrade_into = Path::new(Self::UPGRADE_DIR).join("into");

            tokio::fs::create_dir_all(&upgrade_from)
                .await
                .context(context_str!())?;

            copy_dir_all(Self::DATABASE_PATH, &upgrade_from)
                .await
                .context(context_str!())?;

            while DatabaseVersion::from_database_path(&upgrade_from) != DatabaseVersion::curr() {
                let v = DatabaseVersion::from_database_path(&upgrade_from);
                println!("UPGRADING DATABASE FROM {v:?}");

                let db_from = Database::builder(&upgrade_from)
                    .open()
                    .context(context_str!())?;
                DatabaseVersion::upgrade_database(&db_from, &upgrade_into)
                    .context(context_str!())?;
                drop(db_from);

                // FIXME: Replace with deleting the `from` and renaming the `into` directory to `from`
                tokio::fs::remove_dir_all(&upgrade_from)
                    .await
                    .context(context_str!())?;
                copy_dir_all(&upgrade_into, &upgrade_from)
                    .await
                    .context(context_str!())?;
                tokio::fs::remove_dir_all(&upgrade_into)
                    .await
                    .context(context_str!())?;
            }

            tokio::fs::remove_dir_all(Self::DATABASE_PATH)
                .await
                .context(context_str!())?;
            copy_dir_all(&upgrade_from, Self::DATABASE_PATH)
                .await
                .context(context_str!())?;

            tokio::fs::remove_dir_all(Self::UPGRADE_DIR)
                .await
                .context(context_str!())?;
        }

        let database = Database::builder(Self::DATABASE_PATH)
            .open()
            .context(context_str!())?;

        let this = Self {
            users: database.keyspace(DBKeyspaceId::Users.name(), KeyspaceCreateOptions::default)?,
            strategies: database
                .keyspace(DBKeyspaceId::Strats.name(), KeyspaceCreateOptions::default)?,
            database,
        };

        let backup_frequency = Duration::from_hours(12);

        let handle_clone = this.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(backup_frequency);
            loop {
                interval.tick().await;
                println!("Backing up...");
                let _ = handle_clone.backup().await;
                println!("Backup Complete!");
            }
        });

        Ok(this)
    }

    async fn backup_inner(db: Database) -> anyhow::Result<()> {
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let _ = std::fs::create_dir(Self::BACKUP_PATH);
            db.persist(fjall::PersistMode::SyncAll)?;
            let timestamp = format!("{}", chrono::offset::Utc::now().format("%Y-%m-%d_%H-%M"));
            let out_path = Path::new(Self::BACKUP_PATH).join(format!("backup_{timestamp}.tar.gz"));

            let out_file = BufWriter::new(std::fs::File::create(out_path)?);
            let out_gz = flate2::write::GzEncoder::new(out_file, flate2::Compression::best());

            let mut tarball = tar::Builder::new(out_gz);
            tarball.append_dir_all("", Self::DATABASE_PATH)?;
            tarball.finish()?;

            Ok(())
        })
        .await??;
        Ok(())
    }

    pub async fn backup(&self) -> anyhow::Result<()> {
        let db = self.database.clone();
        Self::backup_inner(db).await
    }

    fn get_keyspace(&self, keyspace: DBKeyspaceId) -> &Keyspace {
        match keyspace {
            DBKeyspaceId::Users => &self.users,
            DBKeyspaceId::Strats => &self.strategies,
        }
    }

    pub async fn get<Keyspace: DBKeyspace>(
        &self,
        key: &Keyspace::Key,
    ) -> anyhow::Result<Option<Keyspace::Entry>> {
        let keyspace = self.get_keyspace(Keyspace::keyspace_id()).clone();
        let key = serde_json::to_vec(key)?;

        let data = tokio::task::spawn_blocking(move || keyspace.get(key)).await??;

        match data {
            Some(data) => {
                let entry = serde_json::from_slice(&data)?;
                Ok(Some(entry))
            }
            _ => Ok(None),
        }
    }

    pub async fn remove<Keyspace: DBKeyspace>(&self, key: &Keyspace::Key) -> anyhow::Result<()> {
        let keyspace = self.get_keyspace(Keyspace::keyspace_id()).clone();
        let key = serde_json::to_vec(key)?;
        tokio::task::spawn_blocking(move || keyspace.remove(key)).await??;
        Ok(())
    }

    pub async fn insert<Keyspace: DBKeyspace>(
        &self,
        key: &Keyspace::Key,
        entry: &Keyspace::Entry,
    ) -> anyhow::Result<()> {
        let keyspace = self.get_keyspace(Keyspace::keyspace_id()).clone();
        let key = serde_json::to_vec(key)?;
        let entry = serde_json::to_vec(entry)?;

        tokio::task::spawn_blocking(move || keyspace.insert(key, entry)).await??;

        Ok(())
    }

    pub async fn get_or_insert_default<Keyspace: DBKeyspace>(
        &self,
        key: &Keyspace::Key,
    ) -> anyhow::Result<Keyspace::Entry> {
        let keyspace = self.get_keyspace(Keyspace::keyspace_id()).clone();
        let key = serde_json::to_vec(key)?;

        tokio::task::spawn_blocking(move || match keyspace.get(&key)? {
            Some(entry) => {
                let entry = serde_json::from_slice(&entry)?;
                Ok(entry)
            }
            None => {
                let entry = Keyspace::Entry::default();
                keyspace.insert(key, serde_json::to_vec(&entry)?)?;
                Ok(entry)
            }
        })
        .await?
    }
}
