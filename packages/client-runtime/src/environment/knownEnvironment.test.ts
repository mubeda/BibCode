import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
} from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attachEnvironmentDescriptor, createKnownEnvironment } from "./knownEnvironment.ts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopedRefKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "./scoped.ts";

describe("known environment bootstrap helpers", () => {
  it("creates known environments from explicit server base urls", () => {
    expect(
      createKnownEnvironment({
        label: "Remote environment",
        target: {
          httpBaseUrl: "https://remote.example.com",
          wsBaseUrl: "wss://remote.example.com",
        },
      }),
    ).toEqual({
      id: "ws:Remote environment",
      label: "Remote environment",
      source: "manual",
      target: {
        httpBaseUrl: "https://remote.example.com",
        wsBaseUrl: "wss://remote.example.com",
      },
    });
  });

  it("retains the descriptor storage identity on an attached environment", () => {
    const environment = createKnownEnvironment({
      label: "Unresolved environment",
      target: {
        httpBaseUrl: "https://remote.example.com",
        wsBaseUrl: "wss://remote.example.com",
      },
    });
    const descriptor = {
      environmentId: EnvironmentId.make("remote"),
      label: "Remote environment",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.3.8",
      storageInstanceId: "0d93cbea-f237-4f37-8829-d816667be35f",
      capabilities: {
        repositoryIdentity: true,
        activityProtocolVersion: 1,
      },
    } satisfies ExecutionEnvironmentDescriptor;

    expect(attachEnvironmentDescriptor(environment, descriptor).storageInstanceId).toBe(
      "0d93cbea-f237-4f37-8829-d816667be35f",
    );
  });

  it("retains the complete descriptor on an attached environment", () => {
    const environment = createKnownEnvironment({
      label: "Unresolved environment",
      target: {
        httpBaseUrl: "https://remote.example.com",
        wsBaseUrl: "wss://remote.example.com",
      },
    });
    const descriptor = {
      environmentId: EnvironmentId.make("remote"),
      label: "Remote environment",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.3.8",
      storageInstanceId: null,
      capabilities: {
        repositoryIdentity: true,
        activityProtocolVersion: null,
      },
    } satisfies ExecutionEnvironmentDescriptor;

    expect(attachEnvironmentDescriptor(environment, descriptor).descriptor).toEqual(descriptor);
  });
});

describe("scoped refs", () => {
  const environmentId = EnvironmentId.make("environment-test");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

  it("builds stable scoped project and thread keys", () => {
    expect(scopedRefKey(projectRef)).toBe("environment-test:project-1");
    expect(scopedRefKey(threadRef)).toBe("environment-test:thread-1");
    expect(scopedProjectKey(projectRef)).toBe("environment-test:project-1");
    expect(scopedThreadKey(threadRef)).toBe("environment-test:thread-1");
  });

  it("returns typed scoped refs", () => {
    expect(projectRef).toEqual({
      environmentId,
      projectId: ProjectId.make("project-1"),
    });
    expect(threadRef).toEqual({
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("parses scoped project and thread keys back into refs", () => {
    expect(parseScopedProjectKey("environment-test:project-1")).toEqual(projectRef);
    expect(parseScopedThreadKey("environment-test:thread-1")).toEqual(threadRef);
    expect(parseScopedProjectKey("bad-key")).toBeNull();
    expect(parseScopedThreadKey("bad-key")).toBeNull();
  });
});
