CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`s3_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`receive_link_id` text,
	`send_link_id` text,
	FOREIGN KEY (`receive_link_id`) REFERENCES `receive_links`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `receive_links` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`password_hash` text,
	`max_uploads` integer,
	`expires_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receive_links_code_unique` ON `receive_links` (`code`);--> statement-breakpoint
CREATE TABLE `upload_tickets` (
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
	CONSTRAINT "upload_tickets_intent_check" CHECK("upload_tickets"."intent" in ('receive', 'send'))
);
