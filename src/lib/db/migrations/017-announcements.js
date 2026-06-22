const migration = {
  version: 17,
  name: "announcements",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS announcements (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        isActive INTEGER NOT NULL DEFAULT 1,
        startsAt TEXT,
        endsAt TEXT,
        createdBy TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  },
};

export default migration;
