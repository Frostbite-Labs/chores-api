CREATE TABLE household_members (
  id              BINARY(16)                          NOT NULL,
  household_id    BINARY(16)                          NOT NULL,
  user_id         BINARY(16)                          NULL,
  role            ENUM('adult','child')               NOT NULL,
  permission      ENUM('owner','admin','member')      NOT NULL,
  display_name    VARCHAR(80)                         NOT NULL,
  avatar          VARCHAR(16)                         NOT NULL,
  color           VARCHAR(9)                          NOT NULL,
  joined_at       DATETIME(3)                         NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  removed_at      DATETIME(3)                         NULL,
  row_version     BIGINT UNSIGNED                     NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_household_user (household_id, user_id),
  KEY idx_member_household (household_id),
  KEY idx_member_user (user_id),
  CONSTRAINT fk_member_household FOREIGN KEY (household_id) REFERENCES households(id),
  CONSTRAINT fk_member_user      FOREIGN KEY (user_id)      REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
