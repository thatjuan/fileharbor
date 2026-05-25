CREATE TABLE `system_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
