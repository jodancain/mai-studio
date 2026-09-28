CREATE TABLE `agent_group_chat_member` (
	`id` text PRIMARY KEY NOT NULL,
	`group_chat_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text,
	`last_seen_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_chat_id`) REFERENCES `agent_group_chat`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `agent_session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_group_chat_member_group_agent_uniq` ON `agent_group_chat_member` (`group_chat_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_group_chat_member_agent_id_idx` ON `agent_group_chat_member` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_group_chat_member_session_id_idx` ON `agent_group_chat_member` (`session_id`);--> statement-breakpoint
CREATE TABLE `agent_group_chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`group_chat_id` text NOT NULL,
	`author_type` text NOT NULL,
	`agent_id` text,
	`author_name` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_chat_id`) REFERENCES `agent_group_chat`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_group_chat_message_author_check" CHECK(("agent_group_chat_message"."author_type" = 'user' AND "agent_group_chat_message"."agent_id" IS NULL) OR "agent_group_chat_message"."author_type" = 'agent')
);
--> statement-breakpoint
CREATE INDEX `agent_group_chat_message_group_created_id_idx` ON `agent_group_chat_message` (`group_chat_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `agent_group_chat` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_group_chat_last_activity_at_idx` ON `agent_group_chat` (`last_activity_at`);