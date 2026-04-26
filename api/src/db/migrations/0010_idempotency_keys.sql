CREATE TABLE idempotency_keys (
  user_id           BINARY(16)      NOT NULL,
  key_value         CHAR(36)        NOT NULL,
  request_hash      CHAR(64)        NOT NULL,
  response_status   SMALLINT UNSIGNED NOT NULL,
  response_body     MEDIUMBLOB      NOT NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at        DATETIME(3)     NOT NULL,
  PRIMARY KEY (user_id, key_value),
  KEY idx_idempotency_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
