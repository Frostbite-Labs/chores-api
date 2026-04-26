CREATE TABLE households (
  id              BINARY(16)      NOT NULL,
  name            VARCHAR(80)     NOT NULL,
  owner_user_id   BINARY(16)      NOT NULL,
  row_version     BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY idx_households_owner (owner_user_id),
  KEY idx_households_deleted_at (deleted_at),
  CONSTRAINT fk_households_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
