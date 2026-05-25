CREATE TABLE `download_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`send_link_id` text NOT NULL,
	`file_id` text NOT NULL,
	`s3_key` text NOT NULL,
	`filename` text NOT NULL,
	`presigned_get_url` text NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`send_link_id`) REFERENCES `send_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `send_links` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`password_hash` text,
	`max_downloads` integer,
	`download_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `send_links_code_unique` ON `send_links` (`code`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_files` (
	`id` text PRIMARY KEY NOT NULL,
	`s3_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`receive_link_id` text,
	`send_link_id` text,
	FOREIGN KEY (`receive_link_id`) REFERENCES `receive_links`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`send_link_id`) REFERENCES `send_links`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_files`("id", "s3_key", "filename", "content_type", "size", "created_at", "receive_link_id", "send_link_id") SELECT "id", "s3_key", "filename", "content_type", "size", "created_at", "receive_link_id", "send_link_id" FROM `files`;--> statement-breakpoint
DROP TABLE `files`;--> statement-breakpoint
ALTER TABLE `__new_files` RENAME TO `files`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_upload_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`intent` text NOT NULL,
	`receive_link_id` text,
	`send_link_id` text,
	`s3_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_hint` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`receive_link_id`) REFERENCES `receive_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`send_link_id`) REFERENCES `send_links`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "upload_tickets_intent_check" CHECK("__new_upload_tickets"."intent" in ('receive', 'send'))
);
--> statement-breakpoint
INSERT INTO `__new_upload_tickets`("id", "intent", "receive_link_id", "send_link_id", "s3_key", "filename", "content_type", "size_hint", "status", "created_at", "completed_at") SELECT "id", "intent", "receive_link_id", "send_link_id", "s3_key", "filename", "content_type", "size_hint", "status", "created_at", "completed_at" FROM `upload_tickets`;--> statement-breakpoint
DROP TABLE `upload_tickets`;--> statement-breakpoint
ALTER TABLE `__new_upload_tickets` RENAME TO `upload_tickets`;