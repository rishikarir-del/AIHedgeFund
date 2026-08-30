CREATE TYPE "public"."decision_outcome" AS ENUM('REJECT', 'REWORK_WITH_NEW_VERSION', 'PAPER_APPROVED');--> statement-breakpoint
CREATE TYPE "public"."rbac_role" AS ENUM('VIEWER', 'RESEARCHER', 'DEVELOPER', 'VALIDATOR', 'OPERATOR', 'COMMITTEE_MEMBER', 'ADMIN', 'SERVICE_ACCOUNT');--> statement-breakpoint
CREATE TYPE "public"."agent_role" AS ENUM('CHIEF_RESEARCH_ORCHESTRATOR', 'IDEA_SCOUT', 'INDICATOR_RESEARCHER', 'STRATEGY_ARCHITECT', 'PINE_ENGINEER', 'BACKTEST_ENGINEER', 'ROBUSTNESS_VALIDATOR', 'FORWARD_TEST_OPERATOR', 'STRATEGY_JUDGE', 'DATA_INTEGRITY_ANALYST', 'PORTFOLIO_RESEARCHER');--> statement-breakpoint
CREATE TYPE "public"."workflow_state" AS ENUM('CAMPAIGN_BACKLOG', 'IDEA_RESEARCH', 'HYPOTHESIS_DRAFT', 'PINE_DEVELOPMENT', 'TRADINGVIEW_VERIFICATION', 'PAPER_APPROVAL_REVIEW', 'PAPER_APPROVED', 'REJECTED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."backtest_source" AS ENUM('tradingview_csv', 'mcp_engine', 'local_runner');--> statement-breakpoint
CREATE TYPE "public"."evidence_scope" AS ENUM('IN_SAMPLE', 'VALIDATION', 'OUT_OF_SAMPLE', 'FINAL_HOLDOUT', 'FORWARD');--> statement-breakpoint
CREATE TYPE "public"."parity_verdict" AS ENUM('PASS', 'WARN', 'FAIL', 'INSUFFICIENT_DATA');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('REQUESTED', 'AWAITING_UPLOAD', 'PARSING', 'PARSED', 'FAILED');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"aggregate" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"prior_state" jsonb,
	"new_state" jsonb,
	"reason" text,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "committee_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"outcome" "decision_outcome" NOT NULL,
	"rationale" text NOT NULL,
	"rejection_case" text,
	"decided_by" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_org_key_uq" UNIQUE("organisation_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "rbac_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_user_uq" UNIQUE("organisation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_subject" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_subject_unique" UNIQUE("external_subject")
);
--> statement-breakpoint
CREATE TABLE "artefacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"checksum" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artefacts_org_checksum_uq" UNIQUE("organisation_id","checksum")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brief" text NOT NULL,
	"state" "workflow_state" DEFAULT 'CAMPAIGN_BACKLOG' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pine_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"source_hash" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"artefact_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pine_revisions_version_hash_uq" UNIQUE("strategy_version_id","source_hash")
);
--> statement-breakpoint
CREATE TABLE "research_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"role" "agent_role" NOT NULL,
	"state" "workflow_state" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_definitions_strategy_version_id_unique" UNIQUE("strategy_version_id")
);
--> statement-breakpoint
CREATE TABLE "strategy_lineage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"child_version_id" uuid NOT NULL,
	"parent_version_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_lineage_edge_uq" UNIQUE("child_version_id","parent_version_id")
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"state" "workflow_state" DEFAULT 'HYPOTHESIS_DRAFT' NOT NULL,
	"definition_hash" text NOT NULL,
	"source_hash" text,
	"manifest_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_versions_number_uq" UNIQUE("strategy_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"source" "backtest_source" NOT NULL,
	"source_identity" jsonb NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"initial_capital" numeric(20, 8) NOT NULL,
	"plan" jsonb NOT NULL,
	"code_hash" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"dataset_hash" text NOT NULL,
	"reported_metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawdown_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"bar_time" timestamp with time zone NOT NULL,
	"drawdown" numeric(20, 8) NOT NULL,
	"drawdown_pct" numeric(10, 6) NOT NULL,
	CONSTRAINT "drawdown_points_run_bar_uq" UNIQUE("run_id","bar_time")
);
--> statement-breakpoint
CREATE TABLE "equity_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"bar_time" timestamp with time zone NOT NULL,
	"equity" numeric(20, 8) NOT NULL,
	CONSTRAINT "equity_points_run_bar_uq" UNIQUE("run_id","bar_time")
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"scope" "evidence_scope" NOT NULL,
	"calculation_version" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_snapshots_run_scope_calc_uq" UNIQUE("run_id","scope","calculation_version")
);
--> statement-breakpoint
CREATE TABLE "parity_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"verdict" "parity_verdict" NOT NULL,
	"first_divergence" jsonb,
	"checked_fields" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"verification_id" uuid NOT NULL,
	"artefact_id" uuid NOT NULL,
	"report_type" text NOT NULL,
	"parser_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_uploads_verification_type_uq" UNIQUE("verification_id","report_type")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"direction" text NOT NULL,
	"entry_time" timestamp with time zone NOT NULL,
	"exit_time" timestamp with time zone,
	"entry_price" numeric(20, 8) NOT NULL,
	"exit_price" numeric(20, 8),
	"quantity" numeric(20, 8) NOT NULL,
	"profit" numeric(20, 8),
	CONSTRAINT "trades_run_sequence_uq" UNIQUE("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "tradingview_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"status" "verification_status" DEFAULT 'REQUESTED' NOT NULL,
	"required_symbol" text NOT NULL,
	"required_timeframe" text NOT NULL,
	"required_source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_decisions" ADD CONSTRAINT "committee_decisions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_decisions" ADD CONSTRAINT "committee_decisions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_decisions" ADD CONSTRAINT "committee_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pine_revisions" ADD CONSTRAINT "pine_revisions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_definitions" ADD CONSTRAINT "strategy_definitions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_lineage" ADD CONSTRAINT "strategy_lineage_child_version_id_strategy_versions_id_fk" FOREIGN KEY ("child_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_lineage" ADD CONSTRAINT "strategy_lineage_parent_version_id_strategy_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawdown_points" ADD CONSTRAINT "drawdown_points_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_points" ADD CONSTRAINT "equity_points_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parity_reports" ADD CONSTRAINT "parity_reports_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_uploads" ADD CONSTRAINT "report_uploads_verification_id_tradingview_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."tradingview_verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_uploads" ADD CONSTRAINT "report_uploads_artefact_id_artefacts_id_fk" FOREIGN KEY ("artefact_id") REFERENCES "public"."artefacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tradingview_verifications" ADD CONSTRAINT "tradingview_verifications_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tradingview_verifications" ADD CONSTRAINT "tradingview_verifications_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_aggregate_idx" ON "audit_events" USING btree ("aggregate","aggregate_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_time_idx" ON "audit_events" USING btree ("organisation_id","created_at");--> statement-breakpoint
CREATE INDEX "committee_decisions_version_idx" ON "committee_decisions" USING btree ("strategy_version_id");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "campaigns_org_state_idx" ON "campaigns" USING btree ("organisation_id","state");--> statement-breakpoint
CREATE INDEX "research_tasks_campaign_idx" ON "research_tasks" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "strategies_org_idx" ON "strategies" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "strategy_versions_state_idx" ON "strategy_versions" USING btree ("organisation_id","state");--> statement-breakpoint
CREATE INDEX "backtest_runs_version_idx" ON "backtest_runs" USING btree ("strategy_version_id","created_at");--> statement-breakpoint
CREATE INDEX "tv_verifications_version_idx" ON "tradingview_verifications" USING btree ("strategy_version_id");