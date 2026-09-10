ALTER TABLE "users" ADD COLUMN "language_code" varchar(10);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_premium" boolean DEFAULT false NOT NULL;