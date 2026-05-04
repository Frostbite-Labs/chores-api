CREATE TABLE user_identities (
  id                BINARY(16)                          NOT NULL,
  user_id           BINARY(16)                          NOT NULL,
  provider          ENUM('google','apple')              NOT NULL,
  provider_subject  VARCHAR(255)                        NOT NULL,
  email_at_link     VARCHAR(254)                        NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_identities_provider_subject (provider, provider_subject),
  KEY idx_identities_user (user_id),
  CONSTRAINT fk_identities_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
