CREATE TABLE "payment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"gateway" varchar(20) DEFAULT 'VIETQR' NOT NULL,
	"external_transaction_id" varchar(255),
	"amount" numeric(15, 2) NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"transfer_content" varchar(255) NOT NULL,
	"bank_name" varchar(100),
	"bank_bin" varchar(20),
	"bank_account" varchar(50),
	"qr_payload" text,
	"expires_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transactions_external_transaction_id_unique" UNIQUE("external_transaction_id"),
	CONSTRAINT "payment_transactions_transfer_content_unique" UNIQUE("transfer_content")
);
--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;