import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ refreshConfig: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, getRefreshTokenShardConfig: mocks.refreshConfig, getTenantIdFromContext: vi.fn(() => 'tenant-a'), createErrorResponse: vi.fn((c, code) => c.json({ error: code }, 400)) };
});
import { getCodeShards, updateCodeShards } from '../routes/settings/code-shards';
function kv(value: string | null = null) { return { get: vi.fn().mockResolvedValue(value), put: vi.fn().mockResolvedValue(undefined) }; }
function context(o:{store?:ReturnType<typeof kv>;envValue?:string;body?:unknown}={}){return {env:{...(o.store?{AUTHRIM_CONFIG:o.store}:{}),...(o.envValue?{AUTHRIM_CODE_SHARDS:o.envValue}:{})},req:{json:vi.fn().mockResolvedValue(o.body??{})},json:vi.fn((v:unknown,s=200)=>Response.json(v,{status:s}))} as never}
describe('authorization code shards settings',()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.refreshConfig.mockResolvedValue({currentShardCount:4})});
 it.each([[null,undefined,4,'default'],[null,'8',8,'env'],['16','8',16,'kv']])('resolves KV/env/default %#',async(kvValue,envValue,current,source)=>{const b=await(await getCodeShards(context({store:kv(kvValue),envValue}))).json() as any;expect(b).toMatchObject({current,source,kv_value:kvValue,env_value:envValue??null})});
 it('requires KV and validates shard bounds/types',async()=>{expect((await updateCodeShards(context({body:{shards:4}}))).status).toBe(400);for(const shards of [0,257,'4',null])expect((await updateCodeShards(context({store:kv(),body:{shards}}))).status).toBe(400)});
 it('rejects mismatch with refresh-token shards',async()=>{mocks.refreshConfig.mockResolvedValueOnce({currentShardCount:8});const store=kv();const r=await updateCodeShards(context({store,body:{shards:4}}));expect(r.status).toBe(400);expect(store.put).not.toHaveBeenCalled()});
 it('updates when shard counts match',async()=>{const store=kv();expect((await updateCodeShards(context({store,body:{shards:4}}))).status).toBe(200);expect(mocks.refreshConfig).toHaveBeenCalledWith(expect.anything(),'__global__','tenant-a');expect(store.put).toHaveBeenCalledWith('code_shards','4')});
 it('allows coordinated update to skip sync check',async()=>{const store=kv();expect((await updateCodeShards(context({store,body:{shards:32,skip_sync_check:true}}))).status).toBe(200);expect(mocks.refreshConfig).not.toHaveBeenCalled()});
 it('allows update when refresh-token config is not initialized',async()=>{mocks.refreshConfig.mockRejectedValueOnce(new Error('missing'));const store=kv();expect((await updateCodeShards(context({store,body:{shards:2}}))).status).toBe(200);expect(store.put).toHaveBeenCalled()});
});
