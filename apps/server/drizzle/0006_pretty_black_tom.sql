CREATE TABLE `pending_aborts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`s3_key` text NOT NULL,
	`upload_id` text NOT NULL,
	`reason` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`last_error` text,
	CONSTRAINT "pending_aborts_reason_check" CHECK("pending_aborts"."reason" in ('link_delete', 'sweep_drain', 'complete_failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pending_aborts_key_upload` ON `pending_aborts` (`s3_key`,`upload_id`);--> statement-breakpoint
CREATE INDEX `idx_pending_aborts_attempts_enqueued` ON `pending_aborts` (`attempts`,`enqueued_at`);--> statement-breakpoint
CREATE TABLE `upload_ticket_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`upload_ticket_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text,
	`size` integer,
	`completed_at` integer,
	FOREIGN KEY (`upload_ticket_id`) REFERENCES `upload_tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "upload_ticket_parts_part_number_check" CHECK("upload_ticket_parts"."part_number" >= 1 AND "upload_ticket_parts"."part_number" <= 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_upload_ticket_parts_ticket_part` ON `upload_ticket_parts` (`upload_ticket_id`,`part_number`);--> statement-breakpoint
ALTER TABLE `upload_tickets` ADD `protocol` text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE `upload_tickets` ADD `upload_id` text;--> statement-breakpoint
ALTER TABLE `upload_tickets` ADD `part_size` integer;--> statement-breakpoint
ALTER TABLE `upload_tickets` ADD `expected_parts` integer;--> statement-breakpoint
ALTER TABLE `upload_tickets` ADD `abort_attempts` integer DEFAULT 0 NOT NULL;