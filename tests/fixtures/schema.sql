-- Schema used by the Phase 4 regression tests.
-- This file is applied once per container bring-up by tests/setup.ts.
-- Keep it additive and compatible with MariaDB 10.6+.

DROP TABLE IF EXISTS t_basic;
DROP TABLE IF EXISTS t_numeric;
DROP TABLE IF EXISTS t_bit;
DROP TABLE IF EXISTS t_dates;
DROP TABLE IF EXISTS t_strings;
DROP TABLE IF EXISTS t_bulk;
DROP TABLE IF EXISTS t_uids;

CREATE TABLE t_basic (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(64) NOT NULL,
  value       INT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE t_numeric (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- Boolean surface
  flag_bool   TINYINT(1) NULL,
  -- Wider TINYINT must not collapse to boolean
  flag_u8     TINYINT(4) NULL,
  -- Large integers
  big_signed   BIGINT NULL,
  big_unsigned BIGINT UNSIGNED NULL,
  -- Precision tests
  dec_small   DECIMAL(10,2) NULL,
  dec_large   DECIMAL(30,8) NULL,
  num_float   FLOAT NULL,
  num_double  DOUBLE NULL
) ENGINE=InnoDB;

CREATE TABLE t_bit (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  b1          BIT(1) NULL,
  b8          BIT(8) NULL,
  b16         BIT(16) NULL
) ENGINE=InnoDB;

CREATE TABLE t_dates (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  d_date      DATE NULL,
  d_datetime  DATETIME NULL,
  d_timestamp TIMESTAMP NULL DEFAULT NULL,
  d_time      TIME NULL,
  d_year      YEAR NULL
) ENGINE=InnoDB;

CREATE TABLE t_strings (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  s_var       VARCHAR(64) NULL,
  s_text      TEXT NULL,
  s_blob      BLOB NULL
) ENGINE=InnoDB;

CREATE TABLE t_bulk (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  k           VARCHAR(32) NOT NULL,
  v           INT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE t_uids (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  note        VARCHAR(32) NULL
) ENGINE=InnoDB AUTO_INCREMENT = 9007199254740993; -- 2^53 + 1
