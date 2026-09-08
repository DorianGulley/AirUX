const requiredVariables = [
  "AIRUX_APP_ORIGIN",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
];

const missingVariables = requiredVariables.filter(
  (name) => !process.env[name]?.trim(),
);

if (missingVariables.length > 0) {
  throw new Error(
    `Missing production Worker variables: ${missingVariables.join(", ")}`,
  );
}
