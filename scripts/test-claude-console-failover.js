#!/usr/bin/env node
/*
 * 最小验证脚本：Claude Console 故障转移（Failover）机制
 * 目标：
 * 1) 校验失败计数在时间窗口内累积
 * 2) 达到阈值后可标记 temp_error，并设置带TTL的临时禁用键
 * 3) 删除临时键后，定时清理逻辑的兜底恢复可将状态恢复为 active
 * 4) 测试边界条件：threshold-1 不触发，threshold 触发
 * 5) 测试成功请求清零计数
 * 6) 测试并发标记保护
 *
 * 运行：node scripts/test-claude-console-failover.js
 */

// 在加载配置前设置更小的测试阈值/窗口/禁用时长（单位：分钟）
process.env.CLAUDE_CONSOLE_ERROR_THRESHOLD = process.env.CLAUDE_CONSOLE_ERROR_THRESHOLD || '3'
process.env.CLAUDE_CONSOLE_ERROR_WINDOW_MINUTES =
  process.env.CLAUDE_CONSOLE_ERROR_WINDOW_MINUTES || '1'
process.env.CLAUDE_CONSOLE_TEMP_DISABLE_MINUTES =
  process.env.CLAUDE_CONSOLE_TEMP_DISABLE_MINUTES || '1'

const logger = require('../src/utils/logger')
const redis = require('../src/models/redis')
const config = require('../config/config')
const claudeConsoleAccountService = require('../src/services/claudeConsoleAccountService')

let testsPassed = 0
let testsFailed = 0

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`)
    testsFailed++
    throw new Error(message)
  } else {
    console.log(`✅ ${message}`)
    testsPassed++
  }
}

async function main() {
  console.log('--- Claude Console Failover Test ---')
  console.log('Config.failover =', config?.claudeConsole?.failover)

  // 1) 连接 Redis
  await redis.connect()
  const client = redis.getClientSafe()

  // 2) 创建临时账户
  const name = `TEST_FAILOVER_${Date.now()}`
  const account = await claudeConsoleAccountService.createAccount({
    name,
    apiUrl: 'https://console.anthropic.com',
    apiKey: 'test_key_only_for_failover_script',
    isActive: true,
    accountType: 'shared'
  })
  const accountId = account.id
  console.log('Created account:', accountId, name)

  try {
    const threshold = config?.claudeConsole?.failover?.threshold || 10
    console.log(`\nUsing threshold = ${threshold}`)

    // ========== TEST 1: 边界条件测试 - threshold-1 不触发 ==========
    console.log('\n📝 TEST 1: 边界条件 - threshold-1 次失败不应触发')
    for (let i = 1; i < threshold; i++) {
      const count = await claudeConsoleAccountService.recordRequestError(accountId, 500)
      console.log(`  Failure ${i}: counter=${count}`)
    }

    let acc = await claudeConsoleAccountService.getAccount(accountId)
    assert(
      acc.status !== 'temp_error',
      `After ${threshold - 1} failures, status should NOT be temp_error (got: ${acc.status})`
    )

    // ========== TEST 2: 成功请求清零计数 ==========
    console.log('\n📝 TEST 2: 成功请求应该清零计数')
    await claudeConsoleAccountService.clearRequestErrors(accountId)
    const countAfterClear = await claudeConsoleAccountService.getRequestErrorCount(accountId)
    assert(countAfterClear === 0, `After clear, counter should be 0 (got: ${countAfterClear})`)

    // ========== TEST 3: 达到阈值触发 temp_error ==========
    console.log('\n📝 TEST 3: 达到阈值后应标记为 temp_error')
    for (let i = 1; i <= threshold; i++) {
      const count = await claudeConsoleAccountService.recordRequestError(accountId, 500)
      console.log(`  Failure ${i}: counter=${count}`)
    }

    const { success } = await claudeConsoleAccountService.markAccountTempError(
      accountId,
      null,
      'test_threshold_reached'
    )
    assert(success, 'Mark temp_error should succeed')

    // ========== TEST 4: 校验账户状态与 TTL ==========
    console.log('\n📝 TEST 4: 校验账户状态和 Redis TTL')
    acc = await claudeConsoleAccountService.getAccount(accountId)
    const tempKey = `${claudeConsoleAccountService.TEMP_ERROR_KEY_PREFIX}${accountId}`
    const ttl = await client.ttl(tempKey)
    console.log(
      `  Account status: ${acc.status}, schedulable: ${acc.schedulable}, tempKey ttl: ${ttl}s`
    )

    assert(
      acc.status === 'temp_error',
      `Status should be temp_error (got: ${acc.status})`
    )
    assert(
      acc.schedulable === false || acc.schedulable === 'false',
      `Schedulable should be false (got: ${acc.schedulable})`
    )
    assert(ttl > 0, `TTL should be positive (got: ${ttl})`)

    // ========== TEST 5: 并发标记保护 ==========
    console.log('\n📝 TEST 5: 测试并发标记保护（分布式锁）')
    // 先恢复账户以便重新测试标记
    await client.del(tempKey)
    await claudeConsoleAccountService.updateAccount(accountId, {
      status: 'active',
      schedulable: 'true'
    })

    // 模拟并发标记
    const results = await Promise.all([
      claudeConsoleAccountService.markAccountTempError(accountId, null, 'concurrent_test_1'),
      claudeConsoleAccountService.markAccountTempError(accountId, null, 'concurrent_test_2'),
      claudeConsoleAccountService.markAccountTempError(accountId, null, 'concurrent_test_3')
    ])

    const successCount = results.filter((r) => r.success === true).length
    const alreadyProcessingCount = results.filter(
      (r) => r.success === false && r.reason === 'already_processing'
    ).length
    console.log(`  Results: ${successCount} success, ${alreadyProcessingCount} already_processing`)

    assert(
      successCount === 1,
      `Only ONE concurrent mark should succeed (got: ${successCount})`
    )
    assert(
      alreadyProcessingCount >= 1,
      `At least one should be rejected by lock (got: ${alreadyProcessingCount})`
    )

    // ========== TEST 6: TTL 过期后自动恢复 ==========
    console.log('\n📝 TEST 6: 模拟 TTL 过期并触发恢复')
    await client.del(tempKey) // 删除 TTL 键模拟过期
    const result = await claudeConsoleAccountService.checkAndRecoverTempErrorAccounts()
    console.log(`  Recovery result: checked=${result.checked}, recovered=${result.recovered}`)

    assert(result.recovered >= 1, `Should recover at least 1 account (got: ${result.recovered})`)

    // ========== TEST 7: 校验恢复后状态 ==========
    console.log('\n📝 TEST 7: 校验账户已恢复为 active')
    const accRecovered = await claudeConsoleAccountService.getAccount(accountId)
    console.log(
      `  Recovered status: ${accRecovered.status}, schedulable: ${accRecovered.schedulable}`
    )

    assert(
      accRecovered.status === 'active',
      `Status should be active after recovery (got: ${accRecovered.status})`
    )
    assert(
      accRecovered.schedulable === true || accRecovered.schedulable === 'true',
      `Schedulable should be true after recovery (got: ${accRecovered.schedulable})`
    )

    console.log(`\n✅ All tests passed! (${testsPassed} assertions passed, ${testsFailed} failed)`)
  } catch (err) {
    console.error('\n❌ Test failed:', err.message)
    console.log(`\nTest summary: ${testsPassed} passed, ${testsFailed} failed`)
  } finally {
    // 8) 清理数据
    try {
      await client.srem(claudeConsoleAccountService.SHARED_ACCOUNTS_KEY, accountId)
      await client.del(`${claudeConsoleAccountService.ACCOUNT_KEY_PREFIX}${accountId}`)
      await client.del(`${claudeConsoleAccountService.REQUEST_ERROR_KEY_PREFIX}${accountId}`)
      await client.del(`${claudeConsoleAccountService.TEMP_ERROR_KEY_PREFIX}${accountId}`)
      await client.del(`${claudeConsoleAccountService.TEMP_ERROR_LOCK_PREFIX}${accountId}`)
      console.log('🧹 Cleanup done')
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr)
    }

    // 9) 断开 Redis
    await redis.disconnect()
  }
}

main().catch((e) => {
  console.error('Unhandled error:', e)
  process.exit(1)
})
