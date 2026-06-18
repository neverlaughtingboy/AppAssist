// Usage:
// #name=target-file&proxy-provider-url=https%3A%2F%2Fexample.com%2Fsurge.conf&proxy-provider-user-agent=Surge%20Mac&proxy-prefix=airport&proxy-exclude=🇸🇬|新加坡|坡|狮城|SG|Singapore&proxy-group=🕳ℹ️jp-auto🏷ℹ️🇯🇵|日本|川日|东京|大阪|泉日|埼玉|沪日|深日|[^-]日|JP|Japan🚫ℹ️尼日利亚|日用&remain-proxy-group=remaining&proxy-domain-dns-config=true
//
// Read a Surge conf from `proxy-provider-url`, or from the Sub-Store file named
// by `name` when the URL is omitted. Copy proxies from its [Proxy] section into
// the current file, and optionally add DNS Host rules for proxy server domains.

log('Start')

const args = $arguments || {}
const name = args.name
const proxyProviderUrl = args['proxy-provider-url'] ?? args.proxyProviderUrl
const proxyProviderUserAgent =
  args['proxy-provider-user-agent'] ?? args.proxyProviderUserAgent ??
  args['proxy-provider-ua'] ?? args.proxyProviderUa
const proxyPrefix = args['proxy-prefix'] ?? args.proxyPrefix ?? name
const proxyExclude = args['proxy-exclude'] ?? args.proxyExclude
const proxyGroup = args['proxy-group'] ?? args.proxyGroup
const remainProxyGroup = args['remain-proxy-group'] ?? args.remainProxyGroup
const proxyDomainDnsConfig =
  args['proxy-domain-dns-config'] ?? args.proxyDomainDnsConfig

if (!name) {
  throw new Error('Missing required argument: name')
}
if (!proxyGroup) {
  throw new Error('Missing required argument: proxy-group')
}

const currentContent = $content ?? $files?.[0]
if (typeof currentContent !== 'string') {
  throw new Error('Current file content is empty or unavailable')
}

const targetContent = await loadTargetContent(name, proxyProviderUrl, proxyProviderUserAgent)

const current = splitContent(currentContent)
const prefix = String(proxyPrefix || name).trim()
const targetState = resolveTargetConfig(targetContent, name, isTrue(proxyDomainDnsConfig))
const target = targetState.target
const targetProxies = targetState.proxies
const filteredProxies = excludeProxies(targetProxies, proxyExclude)
if (filteredProxies.length === 0) {
  throw new Error(`No proxy entries left after proxy-exclude in target file [${name}]`)
}

const managedCacheKey = createCacheKey('managed', name, prefix)
const previousManagedState = normalizeCacheEntry(readCacheEntry(managedCacheKey))
resetManagedContent(current.lines, prefix, previousManagedState)

const renamedProxies = filteredProxies.map(proxy => ({
  ...proxy,
  name: `[${prefix}] ${proxy.name}`,
  line: `${escapeProxyName(`[${prefix}] ${proxy.name}`)} = ${proxy.value}${proxy.comment ? ` ${proxy.comment}` : ''}`,
}))

log(`Append ${renamedProxies.length} proxies into current [Proxy] section`)
appendSectionLines(current.lines, 'Proxy', renamedProxies.map(proxy => proxy.line))

const proxyGroupRules = parseProxyGroupRules(proxyGroup)
log(`Apply ${proxyGroupRules.length} proxy-group rule(s)`)
const groupedProxyNames = applyProxyGroupRules(current.lines, proxyGroupRules, renamedProxies)
applyRemainProxyGroup(current.lines, remainProxyGroup, renamedProxies, groupedProxyNames)

let hostDomains = []
if (isTrue(proxyDomainDnsConfig)) {
  log('proxy-domain-dns-config is enabled')
  const encryptedDnsServer = targetState.encryptedDnsServer
  if (!encryptedDnsServer) {
    throw new Error(`Target file [${name}] does not contain encrypted-dns-server`)
  }

  hostDomains = unique(
    filteredProxies
      .map(proxy => extractProxyDomain(proxy.value))
      .filter(Boolean)
      .map(domain => domain.toLowerCase())
  )

  log(`Append or update ${hostDomains.length} host DNS rule(s)`)
  upsertHostRules(current.lines, hostDomains, encryptedDnsServer)
}

writeCacheEntry(managedCacheKey, {
  version: 1,
  name,
  prefix,
  updatedAt: new Date().toISOString(),
  proxyNames: renamedProxies.map(proxy => proxy.name),
  hostDomains,
})

$content = current.lines.join(current.eol)

log('End')

async function loadTargetContent(targetName, providerUrl, userAgent) {
  const url = String(providerUrl ?? '').trim()
  if (url) {
    log(`Read target Surge conf from proxy-provider-url: ${maskUrl(url)}`)
    if (String(userAgent ?? '').trim()) {
      log('Use custom proxy-provider-user-agent')
    }
    try {
      return await downloadTargetContent(url, userAgent)
    } catch (e) {
      log(`Download proxy-provider-url failed: ${e.message ?? e}`)
      return ''
    }
  }

  log(`Read target Surge conf file: ${targetName}`)
  try {
    return await produceArtifact({
      type: 'file',
      name: targetName,
    })
  } catch (e) {
    log(`Read target Surge conf file [${targetName}] failed: ${e.message ?? e}`)
    return ''
  }
}

async function downloadTargetContent(url, userAgent) {
  const downloader =
    typeof ProxyUtils !== 'undefined' && typeof ProxyUtils?.download === 'function'
      ? ProxyUtils.download
      : typeof download === 'function'
        ? download
        : null

  if (!downloader) {
    throw new Error('proxy-provider-url requires ProxyUtils.download, but it is unavailable')
  }

  const ua = String(userAgent ?? '').trim() || undefined
  const result = await downloader(url, ua, undefined, undefined, undefined, undefined, true)
  if (typeof result === 'string') return result
  if (result && typeof result.body === 'string') return result.body
  return String(result ?? '')
}

function resolveTargetConfig(content, targetName, requireEncryptedDns) {
  const cacheKey = createCacheKey('target-last-good', targetName)
  const fresh = parseTargetConfig(content, requireEncryptedDns)

  if (fresh.valid) {
    const cached = writeCacheEntry(cacheKey, {
      version: 1,
      name: targetName,
      updatedAt: new Date().toISOString(),
      content: String(content ?? ''),
    })
    log(`Target file [${targetName}] is valid, ${cached ? 'updated' : 'skipped'} last-good cache`)
    return fresh
  }

  log(`Target file [${targetName}] is invalid: ${fresh.reason}`)

  const cachedEntry = normalizeCacheEntry(readCacheEntry(cacheKey))
  if (cachedEntry?.content) {
    const cached = parseTargetConfig(cachedEntry.content, requireEncryptedDns)
    if (cached.valid) {
      log(`Use cached target file [${targetName}] from ${cachedEntry.updatedAt || 'unknown time'}`)
      return cached
    }
    log(`Cached target file [${targetName}] is invalid: ${cached.reason}`)
  }

  throw new Error(`Target file [${targetName}] is invalid and no valid last-good cache is available`)
}

function parseTargetConfig(content, requireEncryptedDns) {
  const text = String(content ?? '')
  if (!text.trim()) {
    return { valid: false, reason: 'empty content' }
  }

  const target = splitContent(text)
  const proxies = getProxyEntries(target.lines)
  if (proxies.length === 0) {
    return { valid: false, reason: 'no proxy entries in [Proxy] section' }
  }

  const encryptedDnsServer = getConfigValue(target.lines, 'encrypted-dns-server')
  if (requireEncryptedDns && !encryptedDnsServer) {
    return { valid: false, reason: 'missing encrypted-dns-server' }
  }

  return {
    valid: true,
    target,
    proxies,
    encryptedDnsServer,
  }
}

function resetManagedContent(lines, prefix, previousState) {
  const previousProxyNames = new Set(
    Array.isArray(previousState?.proxyNames) ? previousState.proxyNames : []
  )
  const previousHostDomains = Array.isArray(previousState?.hostDomains)
    ? previousState.hostDomains
    : []

  const removedProxyNames = removeManagedProxyEntries(lines, prefix, previousProxyNames)
  const proxyNamesToRemove = new Set([...previousProxyNames, ...removedProxyNames])

  removeManagedProxyGroupEntries(lines, prefix, proxyNamesToRemove)
  removeManagedHostEntries(lines, previousHostDomains)

  log(
    `Reset managed content: removed ${removedProxyNames.length} proxy/proxies, ${previousHostDomains.length} host domain record(s)`
  )
}

function removeManagedProxyEntries(lines, prefix, previousProxyNames) {
  const bounds = getSectionBounds(lines, 'Proxy')
  if (!bounds) return []

  const removed = []
  for (let index = bounds.end - 1; index > bounds.start; index--) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed) continue
    if (previousProxyNames.has(parsed.key) || isManagedProxyName(parsed.key, prefix)) {
      removed.push(parsed.key)
      lines.splice(index, 1)
    }
  }

  return removed
}

function removeManagedProxyGroupEntries(lines, prefix, proxyNamesToRemove) {
  const bounds = getSectionBounds(lines, 'Proxy Group')
  if (!bounds) return

  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed) continue

    const tokens = splitCommaValues(parsed.value).map(token => token.trim()).filter(Boolean)
    const keptTokens = tokens.filter(token => {
      const name = stripQuotes(token).trim()
      return !proxyNamesToRemove.has(name) && !isManagedProxyName(name, prefix)
    })

    if (keptTokens.length !== tokens.length) {
      lines[index] = `${parsed.indent}${parsed.key} = ${keptTokens.join(', ')}${parsed.comment ? ` ${parsed.comment}` : ''}`
    }
  }
}

function removeManagedHostEntries(lines, domains) {
  if (!domains.length) return
  const bounds = getSectionBounds(lines, 'Host')
  if (!bounds) return

  const domainSet = new Set(domains.map(domain => String(domain).toLowerCase()))
  for (let index = bounds.end - 1; index > bounds.start; index--) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed) continue
    if (domainSet.has(parsed.key.toLowerCase())) {
      lines.splice(index, 1)
    }
  }
}

function isManagedProxyName(name, prefix) {
  return String(name).startsWith(`[${prefix}] `)
}

function excludeProxies(proxies, pattern) {
  if (!pattern) {
    log(`proxy-exclude is empty, keep all ${proxies.length} proxy/proxies`)
    return proxies
  }

  const regex = createExcludeRegExp(pattern)
  const filtered = proxies.filter(proxy => !regex.test(proxy.name))
  log(`proxy-exclude ${regex} removed ${proxies.length - filtered.length}/${proxies.length} proxy/proxies`)
  return filtered
}

function parseProxyGroupRules(value) {
  return String(value)
    .split('🕳')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const [groupPattern, namePattern = '.*'] = item.split('🏷')
      const [includePattern = '.*', excludePattern] = namePattern.split('🚫')
      const groupRegex = createRegExp(groupPattern)
      const includeRegex = createRegExp(includePattern)
      const excludeRegex = excludePattern ? createRegExp(excludePattern) : null
      log(`Rule: group ${groupRegex}, proxy ${includeRegex}${excludeRegex ? `, exclude ${excludeRegex}` : ''}`)
      return { groupRegex, includeRegex, excludeRegex }
    })
}

function applyProxyGroupRules(lines, rules, proxies) {
  const bounds = getSectionBounds(lines, 'Proxy Group')
  const groupedProxyNames = new Set()
  if (!bounds) {
    log('No [Proxy Group] section found, skip proxy-group rules')
    return groupedProxyNames
  }

  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed) continue

    const matchedNames = []
    for (const rule of rules) {
      if (!rule.groupRegex.test(parsed.key)) continue
      const names = proxies
        .filter(proxy => rule.includeRegex.test(proxy.name))
        .filter(proxy => !rule.excludeRegex || !rule.excludeRegex.test(proxy.name))
        .map(proxy => proxy.name)
      matchedNames.push(...names)
      log(`Proxy Group [${parsed.key}] matched ${names.length} proxy/proxies`)
    }

    const namesToInsert = unique(matchedNames)
    if (namesToInsert.length === 0) continue

    namesToInsert.forEach(name => groupedProxyNames.add(name))

    insertProxyNamesIntoParsedLine(lines, index, parsed, namesToInsert)
  }

  return groupedProxyNames
}

function applyRemainProxyGroup(lines, groupName, proxies, groupedProxyNames) {
  if (!groupName) return

  const remainNames = proxies
    .map(proxy => proxy.name)
    .filter(name => !groupedProxyNames.has(name))

  if (remainNames.length === 0) {
    log(`remain-proxy-group [${groupName}] has no remaining proxy/proxies`)
    return
  }

  const index = findProxyGroupLineIndex(lines, groupName)
  if (index === -1) {
    log(`remain-proxy-group [${groupName}] not found, skip ${remainNames.length} remaining proxy/proxies`)
    return
  }

  const parsed = parseKeyValueLine(lines[index])
  if (!parsed) return

  log(`remain-proxy-group [${parsed.key}] append ${remainNames.length} remaining proxy/proxies`)
  insertProxyNamesIntoParsedLine(lines, index, parsed, remainNames)
}

function findProxyGroupLineIndex(lines, groupName) {
  const bounds = getSectionBounds(lines, 'Proxy Group')
  if (!bounds) return -1

  const expected = String(groupName).trim()
  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed) continue
    if (parsed.key === expected) return index
  }

  return -1
}

function insertProxyNamesIntoParsedLine(lines, index, parsed, names) {
  const tokens = splitCommaValues(parsed.value).map(token => token.trim()).filter(Boolean)
  const existing = new Set(tokens.map(token => stripQuotes(token).trim()))
  const missing = unique(names).filter(name => !existing.has(name))
  if (missing.length === 0) return

  const intervalIndex = tokens.findIndex(token => /^interval\s*=/i.test(token))
  const insertIndex = intervalIndex >= 0 ? intervalIndex : tokens.length
  tokens.splice(insertIndex, 0, ...missing)

  lines[index] = `${parsed.indent}${parsed.key} = ${tokens.join(', ')}${parsed.comment ? ` ${parsed.comment}` : ''}`
}

function upsertHostRules(lines, domains, encryptedDnsServer) {
  if (domains.length === 0) return

  const bounds = ensureSection(lines, 'Host')
  const existingHostLines = new Map()

  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed) continue
    existingHostLines.set(parsed.key.toLowerCase(), index)
  }

  const newLines = []
  for (const domain of domains) {
    const line = `${domain} = server:${encryptedDnsServer}`
    const existingIndex = existingHostLines.get(domain)
    if (existingIndex === undefined) {
      newLines.push(line)
    } else {
      lines[existingIndex] = line
    }
  }

  if (newLines.length > 0) {
    insertSectionLines(lines, 'Host', newLines)
  }
}

function getProxyEntries(lines) {
  const bounds = getSectionBounds(lines, 'Proxy')
  if (!bounds) return []

  const proxies = []
  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed) continue
    if (!parsed.value) continue
    proxies.push({
      name: parsed.key,
      value: parsed.value,
      comment: parsed.comment,
      line: lines[index],
    })
  }
  return proxies
}

function extractProxyDomain(value) {
  const tokens = splitCommaValues(value).map(token => token.trim()).filter(Boolean)
  if (tokens.length < 2) return ''

  const protocol = stripQuotes(tokens[0]).trim().toLowerCase()
  if (/^(direct|reject|reject-drop|reject-tinygif)$/i.test(protocol)) return ''

  let server = tokens[1]
  const keyValueServer = tokens.find(token => /^(server|host|hostname)\s*=/i.test(token.trim()))
  if (/^\w[\w-]*\s*=/.test(server) && keyValueServer) {
    server = keyValueServer.replace(/^[^=]+=/, '')
  }

  server = normalizeDomain(server)
  return isValidDomain(server) ? server : ''
}

function normalizeDomain(value) {
  let domain = stripQuotes(String(value || '').trim())
  domain = domain.replace(/^\[/, '').replace(/\]$/, '')
  domain = domain.replace(/\.$/, '')
  return domain
}

function isValidDomain(domain) {
  if (!domain) return false
  if (domain.length > 253) return false
  if (typeof ProxyUtils !== 'undefined' && ProxyUtils?.isIP?.(domain)) return false
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(domain)) return false
  if (/[:/?#@*_\s]/.test(domain)) return false
  if (!domain.includes('.')) return false

  return domain
    .split('.')
    .every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
    )
}

function getConfigValue(lines, key) {
  const keyLower = key.toLowerCase()
  for (const line of lines) {
    const parsed = parseKeyValueLine(line)
    if (!parsed) continue
    if (parsed.key.toLowerCase() === keyLower) return parsed.value
  }
  return ''
}

function appendSectionLines(lines, sectionName, additions) {
  insertSectionLines(lines, sectionName, additions)
}

function insertSectionLines(lines, sectionName, additions) {
  if (!additions.length) return
  const bounds = ensureSection(lines, sectionName)
  const insertAt = getSectionInsertIndex(lines, bounds)
  lines.splice(insertAt, 0, ...additions)
}

function getSectionInsertIndex(lines, bounds) {
  let index = bounds.end
  while (index > bounds.start + 1 && lines[index - 1].trim() === '') {
    index--
  }
  return index
}

function ensureSection(lines, sectionName) {
  const bounds = getSectionBounds(lines, sectionName)
  if (bounds) return bounds

  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
    lines.push('')
  }
  lines.push(`[${sectionName}]`)
  return {
    start: lines.length - 1,
    end: lines.length,
  }
}

function getSectionBounds(lines, sectionName) {
  const expected = sectionName.toLowerCase()
  let start = -1

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/)
    if (!match) continue
    if (match[1].trim().toLowerCase() === expected) {
      start = index
      break
    }
  }

  if (start === -1) return null

  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*\[[^\]]+\]\s*(?:[#;].*)?$/.test(lines[index])) {
      end = index
      break
    }
  }

  return { start, end }
}

function parseKeyValueLine(line) {
  if (!line || /^\s*[#;]/.test(line)) return null

  const { body, comment } = splitInlineComment(line)
  const equalIndex = body.indexOf('=')
  if (equalIndex < 0) return null

  const indent = body.match(/^\s*/)?.[0] || ''
  const key = body.slice(0, equalIndex).trim()
  const value = body.slice(equalIndex + 1).trim()
  if (!key) return null

  return { indent, key, value, comment }
}

function splitInlineComment(line) {
  let quote = ''
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote) {
      if (char === '\\') {
        index++
      } else if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if ((char === '#' || char === ';') && (index === 0 || /\s/.test(line[index - 1]))) {
      return {
        body: line.slice(0, index).trimEnd(),
        comment: line.slice(index).trim(),
      }
    }
  }

  return { body: line.trimEnd(), comment: '' }
}

function splitCommaValues(value) {
  const result = []
  let current = ''
  let quote = ''
  let depth = 0

  for (let index = 0; index < value.length; index++) {
    const char = value[index]

    if (quote) {
      current += char
      if (char === '\\') {
        index++
        current += value[index] || ''
      } else if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    if (char === '[' || char === '(' || char === '{') {
      depth++
    } else if (char === ']' || char === ')' || char === '}') {
      depth = Math.max(0, depth - 1)
    }

    if (char === ',' && depth === 0) {
      result.push(current)
      current = ''
      continue
    }

    current += char
  }

  result.push(current)
  return result
}

function splitContent(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  return {
    eol,
    lines: content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n'),
  }
}

function stripQuotes(value) {
  const text = String(value || '').trim()
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1)
  }
  return text
}

function escapeProxyName(name) {
  return String(name).replace(/\r?\n/g, ' ').trim()
}

function unique(values) {
  return [...new Set(values)]
}

function isTrue(value) {
  return /^(true|1|yes|on)$/i.test(String(value ?? '').trim())
}

function createRegExp(pattern) {
  const source = String(pattern || '.*')
  const ignoreCase = source.includes('ℹ️')
  const cleanSource = source.split('ℹ️').join('')
  return new RegExp(cleanSource || '.*', ignoreCase ? 'i' : undefined)
}

function createExcludeRegExp(pattern) {
  const source = String(pattern || '.*')
  const cleanSource = source.split('ℹ️').join('')
  return new RegExp(cleanSource || '.*', 'i')
}

function readCacheEntry(key) {
  try {
    if (typeof $substore !== 'undefined' && $substore?.read) {
      const value = $substore.read(toPersistentCacheKey(key))
      if (value) return value
    }
  } catch (e) {
    log(`Read $substore failed: ${e.message ?? e}`)
  }

  try {
    if (typeof $persistentStore !== 'undefined' && $persistentStore?.read) {
      const value = $persistentStore.read(key)
      if (value) return value
    }
  } catch (e) {
    log(`Read $persistentStore failed: ${e.message ?? e}`)
  }

  return null
}

function writeCacheEntry(key, value) {
  let persisted = false

  try {
    if (typeof $substore !== 'undefined' && $substore?.write) {
      $substore.write(JSON.stringify(value), toPersistentCacheKey(key))
      persisted = true
    }
  } catch (e) {
    log(`Write $substore failed: ${e.message ?? e}`)
  }

  if (persisted) return true

  try {
    if (typeof $persistentStore !== 'undefined' && $persistentStore?.write) {
      return $persistentStore.write(JSON.stringify(value), key)
    }
  } catch (e) {
    log(`Write $persistentStore failed: ${e.message ?? e}`)
  }

  log(`No cache backend available for key: ${key}`)
  return false
}

function normalizeCacheEntry(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return { content: value }
    }
  }
  return null
}

function createCacheKey(...parts) {
  return ['surge-template', ...parts.map(part => encodeURIComponent(String(part)))].join(':')
}

function toPersistentCacheKey(key) {
  return `#${key}`
}

function maskUrl(value) {
  const text = String(value || '')
  try {
    const url = new URL(text)
    return `${url.protocol}//${url.host}${url.pathname ? '/***' : ''}`
  } catch {
    return text.replace(/([?&][^=]*?(?:token|key|secret|password|passwd|pwd|auth)[^=]*=)[^&#]+/gi, '$1***')
  }
}

function log(message) {
  console.log(`[Surge template] ${message}`)
}
