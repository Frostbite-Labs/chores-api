CREATE TABLE sync_tombstones (
  household_id          BINARY(16)                              NOT NULL,
  entity_type           ENUM('task','member','completion')      NOT NULL,
  entity_id             BINARY(16)                              NOT NULL,
  deleted_row_version   BIGINT UNSIGNED                         NOT NULL,
  deleted_at            DATETIME(3)                             NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (household_id, entity_type, entity_id),
  KEY idx_tombstones_household_version (household_id, deleted_row_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
