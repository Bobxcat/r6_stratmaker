use std::path::Path;

use anyhow::Context;
use fjall::{Database, KeyspaceCreateOptions};
use strum::VariantArray;

use crate::{context_str, database_versions::v1::UpgradeV0ToV1};

mod v0;
mod v1;

pub mod curr {
    pub use super::v1::*;
}

const VERSION_KEYSPACE: &str = "VERSION";
const VERSION_KEYSPACE_KEY: &str = "V";

#[derive(Debug, Clone, Copy, PartialEq, Eq, VariantArray)]
pub enum DatabaseVersion {
    V0,
    V1,
}

impl DatabaseVersion {
    pub fn curr() -> Self {
        Self::V1
    }

    pub fn to_bytes(self) -> &'static [u8] {
        match self {
            DatabaseVersion::V0 => b"V0",
            DatabaseVersion::V1 => b"V1",
        }
    }

    pub fn from_bytes(bytes: &[u8]) -> Self {
        match bytes {
            b"V0" => Self::V0,
            b"V1" => Self::V1,
            _ => panic!("Invalid bytes: `{bytes:?}` ({:?})", str::from_utf8(bytes)),
        }
    }

    pub fn from_database_path(path: impl AsRef<Path>) -> Self {
        Self::from_database(&Database::builder(path).open().unwrap())
    }

    pub fn from_database(database: &Database) -> Self {
        if database.keyspace_exists(VERSION_KEYSPACE) {
            let keyspace = database
                .keyspace(VERSION_KEYSPACE, KeyspaceCreateOptions::default)
                .unwrap();
            match keyspace.get(VERSION_KEYSPACE_KEY) {
                Ok(Some(sl)) => Self::from_bytes(&sl),
                _ => Self::V0,
            }
        } else {
            Self::V0
        }
    }

    #[track_caller]
    pub fn upgrade_database(
        db_old: &Database,
        upgrade_into: impl AsRef<Path>,
    ) -> anyhow::Result<()> {
        let upgrade_into = upgrade_into.as_ref();

        let version = Self::from_database(db_old);
        if version == Self::curr() {
            return Ok(());
        }

        let db_new = Database::builder(upgrade_into)
            .open()
            .context(context_str!())?;

        let next_version = match version {
            DatabaseVersion::V0 => {
                UpgradeV0ToV1::upgrade(db_old, &db_new).context(context_str!())?;
                DatabaseVersion::V1
            }
            DatabaseVersion::V1 => unreachable!(),
        };

        let version_keyspace = db_new.keyspace(VERSION_KEYSPACE, KeyspaceCreateOptions::default)?;
        version_keyspace
            .insert(VERSION_KEYSPACE_KEY, next_version.to_bytes())
            .context(context_str!())?;

        Ok(())
    }
}

trait DBUpgrader {
    fn upgrade(db_old: &Database, db_new: &Database) -> anyhow::Result<()>;
}

#[test]
#[cfg(test)]
fn database_version_serialize() {
    for v in DatabaseVersion::VARIANTS {
        assert_eq!(DatabaseVersion::from_bytes(v.to_bytes()), *v);
    }
}
