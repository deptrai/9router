CREATE TABLE "supplier_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"supplier_source_id" uuid,
	"external_order_id" varchar(255),
	"cost" numeric(18, 2),
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"raw_payload" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "supplier_orders_status_valid" CHECK ("supplier_orders"."status" IN ('PENDING', 'SUCCESS', 'FAILED')),
	CONSTRAINT "supplier_orders_cost_non_negative" CHECK ("supplier_orders"."cost" IS NULL OR "supplier_orders"."cost" >= 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_supplier_source_id_supplier_sources_id_fk" FOREIGN KEY ("supplier_source_id") REFERENCES "public"."supplier_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_orders_order_idx" ON "supplier_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "supplier_orders_supplier_idx" ON "supplier_orders" USING btree ("supplier_source_id");--> statement-breakpoint
CREATE INDEX "supplier_orders_status_idx" ON "supplier_orders" USING btree ("status");