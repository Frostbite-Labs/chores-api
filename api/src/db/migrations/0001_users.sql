CREATE TABLE users (
  id              BINARY(16)      NOT NULL,
  email           VARCHAR(254)    NULL,
  email_verified  TINYINT(1)      NOT NULL DEFAULT 0,
  display_name    VARCHAR(80)     NOT NULL,
  avatar          VARCHAR(16)     NOT NULL DEFAULT '⭐',
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_deleted_at (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
