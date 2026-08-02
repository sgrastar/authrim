export type ManagedPluginResourceKind = 'd1' | 'kv_namespace' | 'r2_bucket';

export interface ManagedPluginResourceIdentity {
  kind: ManagedPluginResourceKind;
  providerResourceId: string;
  providerName: string;
}

export interface ManagedPluginResourceDeletionApi {
  d1: {
    getD1Database(id: string): Promise<{ uuid: string; name: string }>;
    deleteD1Database(id: string): Promise<void>;
  };
  kv: {
    listKvNamespaces(): Promise<Array<{ id: string; title: string }>>;
    deleteKvNamespace(id: string): Promise<void>;
  };
  r2: {
    listR2Buckets(): Promise<Array<{ name: string }>>;
    deleteR2Bucket(name: string): Promise<void>;
  };
}

function isNotFound(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    !Array.isArray(error) &&
    (error as { status?: unknown }).status === 404
  );
}

export async function ensureManagedPluginResourceDeleted(input: {
  resource: ManagedPluginResourceIdentity;
  api: ManagedPluginResourceDeletionApi;
}): Promise<void> {
  const { resource, api } = input;
  if (resource.kind === 'd1') {
    let present = false;
    try {
      const reflected = await api.d1.getD1Database(resource.providerResourceId);
      if (
        reflected.uuid !== resource.providerResourceId ||
        reflected.name !== resource.providerName
      ) {
        throw new Error('control_plugin_cleanup_provider_identity_mismatch');
      }
      present = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (present) {
      try {
        await api.d1.deleteD1Database(resource.providerResourceId);
      } catch (error) {
        try {
          await api.d1.getD1Database(resource.providerResourceId);
          throw error;
        } catch (reflectionError) {
          if (!isNotFound(reflectionError)) throw reflectionError;
        }
      }
    }
    try {
      await api.d1.getD1Database(resource.providerResourceId);
      throw new Error('control_plugin_cleanup_provider_still_present');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return;
  }

  if (resource.kind === 'kv_namespace') {
    const exact = (await api.kv.listKvNamespaces()).find(
      (candidate) => candidate.id === resource.providerResourceId
    );
    if (exact && exact.title !== resource.providerName) {
      throw new Error('control_plugin_cleanup_provider_identity_mismatch');
    }
    if (exact) {
      try {
        await api.kv.deleteKvNamespace(resource.providerResourceId);
      } catch (error) {
        if ((await api.kv.listKvNamespaces()).some((candidate) => candidate.id === exact.id)) {
          throw error;
        }
      }
    }
    if (
      (await api.kv.listKvNamespaces()).some(
        (candidate) => candidate.id === resource.providerResourceId
      )
    ) {
      throw new Error('control_plugin_cleanup_provider_still_present');
    }
    return;
  }

  if (resource.providerResourceId !== resource.providerName) {
    throw new Error('control_plugin_cleanup_provider_identity_mismatch');
  }
  const exact = (await api.r2.listR2Buckets()).find(
    (candidate) => candidate.name === resource.providerName
  );
  if (exact) {
    try {
      await api.r2.deleteR2Bucket(resource.providerName);
    } catch (error) {
      if ((await api.r2.listR2Buckets()).some((candidate) => candidate.name === exact.name)) {
        throw error;
      }
    }
  }
  if (
    (await api.r2.listR2Buckets()).some((candidate) => candidate.name === resource.providerName)
  ) {
    throw new Error('control_plugin_cleanup_provider_still_present');
  }
}
