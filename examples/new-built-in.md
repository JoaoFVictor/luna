# Create A New Built-In

Built-ins are deterministic workflow operations exposed by a capability
manifest and called from workflow YAML with `type: built_in`.

Use a built-in for deterministic behavior: validation, git operations, context
collection, report shaping, provider task context, local command execution, or
runtime state plumbing. Use an agent for model judgment. Use an adapter only to
normalize external input into an invocation.

## 1. Pick The Owning Capability

Add reusable behavior under `src/capabilities/<capability>/`. Provider-specific
behavior belongs under `src/providers/<provider>/` and is wired through native
platform/provider composition.

For provider-backed publishing, keep the public operation provider-neutral. The
capability owns the built-in id, input/output contracts, side-effect policy, and
port shape. Each provider owns its API/auth/payload implementation. Existing
examples are `pull-request-review.publish` and `change-request.create`.

Shared contracts and registry mechanics live under `src/core/built-ins/**`;
they are not the ownership home for new public domain behavior.

Create a new capability only when the behavior does not fit an existing one.

## 2. Register The Public Id

Update the owning `manifest.ts` with the new built-in id, schemas, required
ports, and side-effect policy when needed.

Example shape:

```ts
built_ins: {
  "my-capability.do_thing": {
    id: "my-capability.do_thing",
    input_schema: { type: "object", additionalProperties: false },
    output_schema: { type: "object", additionalProperties: true },
    required_ports: []
  }
}
```

Side-effecting operations need a policy in the manifest and a matching workflow
`policies:` entry.

If the operation needs a provider, register a provider-neutral port in the
manifest and use the shared provider registry mechanics from
`src/core/providers/registry.ts` in composition code. Do not add a new
capability-specific provider registry unless lookup behavior truly differs.

## 3. Implement The Step

Use the existing built-in definition pattern in the owning capability. Keep the
step small and return checkpoint-safe JSON.

Do not import provider auth/config/payloads into neutral capabilities. Do not
import runtime SDKs into built-in code.

## 4. Wire Execution

Make sure native workflow executors can find the built-in. Provider-specific
steps should be exposed through the provider/plugin composition root. Generic
capability steps should be wired where existing capability built-ins are
assembled.

Workflow validation and runtime execution must see the same active
registration.

For provider-backed capabilities, wire provider factories in
`src/platform/native/native-platform-plugins.ts` and expose the active provider
ports through native workflow executor dependencies.

## 5. Use It In Workflow YAML

```yaml
- id: my_step
  type: built_in
  uses: my-capability.do_thing
  input:
    previous:
      expression: "$.steps.previous"
  artifacts:
    - path: my-step.json
      publisher: artifacts.manifest_publisher
      source:
        expression: "$.steps.my_step"
      format: json
  after:
    - previous
```

Plain strings are literals. Use `{ expression: "..." }` for state references.

## 6. Test

Add focused tests under `tests/capabilities/<capability>/` when possible. Also
cover workflow definition validation if the manifest, schema, policy, or
capability declaration behavior changes.

Run:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
