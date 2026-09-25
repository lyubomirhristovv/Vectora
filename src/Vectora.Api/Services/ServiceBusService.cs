using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using Vectora.Api.Helpers;
using Vectora.Api.Models;
using Vectora.Api.Repositories;

namespace Vectora.Api.Services;

public class ServiceBusService : IServiceBusService
{
    private readonly IConnectionRepository _connectionRepository;
    private readonly IServiceBusClientCache _clientCache;
    private readonly IServiceBusEntityCache _entityCache;
    private readonly IEmulatorCountRefresher _countRefresher;
    private readonly ISettingsService _settingsService;
    private readonly ILogger<ServiceBusService> _logger;
    private readonly int _emulatorAdminPort;

    public ServiceBusService(IConnectionRepository connectionRepository, IServiceBusClientCache clientCache, IServiceBusEntityCache entityCache, IEmulatorCountRefresher countRefresher, ISettingsService settingsService, ILogger<ServiceBusService> logger, IConfiguration configuration)
    {
        _connectionRepository = connectionRepository;
        _clientCache = clientCache;
        _entityCache = entityCache;
        _countRefresher = countRefresher;
        _settingsService = settingsService;
        _logger = logger;
        _emulatorAdminPort = configuration.GetValue<int?>("EmulatorAdminPort") ?? EmulatorAdmin.DefaultAdminPort;
    }

    // The administration client for entity management. Emulators are driven through the same client
    // as real Service Bus, just pointed at the management port; Vectora requires an emulator build
    // that serves the management API (Azure Service Bus Emulator with SDK >= 7.20). If it isn't
    // listening, admin calls surface the failure rather than degrading to a partial view.
    private ServiceBusAdministrationClient GetManagementClient(ServiceBusConnection connection)
    {
        if (!connection.IsEmulator)
        {
            return _clientCache.GetAdminClient(connection.Id, connection.ConnectionString);
        }

        var adminConnectionString = EmulatorAdmin.BuildAdminConnectionString(connection.ConnectionString, _emulatorAdminPort);
        return _clientCache.GetEmulatorAdminClient(connection.Id, connection.ConnectionString, adminConnectionString);
    }

    public async Task<(List<QueueInfoDto> Queues, List<TopicInfoDto> Topics)?> GetEntitiesAsync(int connectionId, bool refreshCache = false, CancellationToken cancellationToken = default)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        if (!refreshCache && _entityCache.TryGet(connectionId, out var cached))
        {
            return (cached.Queues, cached.Topics);
        }

        var queues = new List<QueueInfoDto>();
        var topics = new List<TopicInfoDto>();

        await PopulateFromAdminAsync(GetManagementClient(connection), connection, queues, topics, cancellationToken);

        var orderedQueues = queues.OrderBy(q => q.Name).ToList();
        var orderedTopics = topics.OrderBy(t => t.Name).ToList();

        if (connection.IsEmulator)
        {
            MarkCountsUnknown(orderedQueues, orderedTopics);
        }

        // Carry over the counts we already know. A fresh enumeration builds new DTOs, so without
        // this every refresh would blank the counts until the sweep catches up.
        if (connection.IsEmulator && _entityCache.TryGet(connectionId, out var previous))
        {
            CopyCounts(previous, orderedQueues, orderedTopics);
        }

        _entityCache.Set(connectionId, orderedQueues, orderedTopics);

        // Emulator counts come from browsing, which is too slow to hold a request open (see
        // EmulatorCountRefresher). Cache first, then let the sweep fill the numbers in place.
        _countRefresher.Trigger(connection);

        return (orderedQueues, orderedTopics);
    }

    // Enumerate entities and message counts through the administration client. Counts are accurate
    // for real Service Bus; the emulator returns zeros, which EmulatorCountRefresher replaces.
    private static async Task PopulateFromAdminAsync(ServiceBusAdministrationClient adminClient, ServiceBusConnection connection, List<QueueInfoDto> queues, List<TopicInfoDto> topics, CancellationToken cancellationToken)
    {
        // RequiresSession lives on the entity properties (not the runtime properties that
        // carry message counts), so we pull both and merge by name.
        var sessionByQueue = new Dictionary<string, bool>();
        await foreach (var queue in adminClient.GetQueuesAsync(cancellationToken))
        {
            sessionByQueue[queue.Name] = queue.RequiresSession;
        }

        await foreach (var queue in adminClient.GetQueuesRuntimePropertiesAsync(cancellationToken))
        {
            queues.Add(new QueueInfoDto { Name = queue.Name, ActiveMessageCount = queue.ActiveMessageCount, DeadLetterMessageCount = queue.DeadLetterMessageCount, IsEmulator = connection.IsEmulator, RequiresSession = sessionByQueue.GetValueOrDefault(queue.Name) });
        }

        await foreach (var topic in adminClient.GetTopicsAsync(cancellationToken))
        {
            var sessionBySubscription = new Dictionary<string, bool>();
            await foreach (var sub in adminClient.GetSubscriptionsAsync(topic.Name, cancellationToken))
            {
                sessionBySubscription[sub.SubscriptionName] = sub.RequiresSession;
            }

            var subs = new List<SubscriptionInfoDto>();
            await foreach (var sub in adminClient.GetSubscriptionsRuntimePropertiesAsync(topic.Name, cancellationToken))
            {
                subs.Add(new SubscriptionInfoDto { Name = sub.SubscriptionName, ActiveMessageCount = sub.ActiveMessageCount, DeadLetterMessageCount = sub.DeadLetterMessageCount, RequiresSession = sessionBySubscription.GetValueOrDefault(sub.SubscriptionName) });
            }
            topics.Add(new TopicInfoDto { Name = topic.Name, Subscriptions = subs, IsEmulator = connection.IsEmulator });
        }
    }

    // Emulator counts come from browsing, so a freshly enumerated entity has no count yet — the
    // admin-reported zero it arrives with is meaningless and must not read as an exact total.
    private static void MarkCountsUnknown(List<QueueInfoDto> queues, List<TopicInfoDto> topics)
    {
        foreach (var queue in queues)
        {
            queue.ActiveCountExact = false;
            queue.DeadLetterCountExact = false;
        }
        foreach (var sub in topics.SelectMany(topic => topic.Subscriptions))
        {
            sub.ActiveCountExact = false;
            sub.DeadLetterCountExact = false;
        }
    }

    // Preserves already-known emulator counts across a re-enumeration, matched by name.
    private static void CopyCounts((List<QueueInfoDto> Queues, List<TopicInfoDto> Topics) previous, List<QueueInfoDto> queues, List<TopicInfoDto> topics)
    {
        var previousQueues = previous.Queues.ToDictionary(q => q.Name, StringComparer.Ordinal);
        foreach (var queue in queues)
        {
            if (!previousQueues.TryGetValue(queue.Name, out var old)) continue;
            queue.ActiveMessageCount = old.ActiveMessageCount;
            queue.DeadLetterMessageCount = old.DeadLetterMessageCount;
            queue.ActiveCountExact = old.ActiveCountExact;
            queue.DeadLetterCountExact = old.DeadLetterCountExact;
        }

        var previousTopics = previous.Topics.ToDictionary(t => t.Name, StringComparer.Ordinal);
        foreach (var topic in topics)
        {
            if (!previousTopics.TryGetValue(topic.Name, out var oldTopic)) continue;
            var previousSubs = oldTopic.Subscriptions.ToDictionary(sub => sub.Name, StringComparer.Ordinal);
            foreach (var sub in topic.Subscriptions)
            {
                if (!previousSubs.TryGetValue(sub.Name, out var old)) continue;
                sub.ActiveMessageCount = old.ActiveMessageCount;
                sub.DeadLetterMessageCount = old.DeadLetterMessageCount;
                sub.ActiveCountExact = old.ActiveCountExact;
                sub.DeadLetterCountExact = old.DeadLetterCountExact;
            }
        }
    }

    public async Task<QueueInfoDto?> GetQueueRuntimeInfoAsync(int connectionId, string queueName, bool recount = false, CancellationToken cancellationToken = default)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        // Emulator counts are browse-derived and maintained by the background sweep, so serve the
        // last-known values. Deliberately no scan is started here: counting this entity would
        // compete with the message read that follows a user opening it.
        if (connection.IsEmulator)
        {
            if (recount)
            {
                await _countRefresher.CountEntityNowAsync(connection, queueName, null, cancellationToken);
            }

            var known = _entityCache.TryGet(connectionId, out var cached)
                ? cached.Queues.FirstOrDefault(q => q.Name == queueName)
                : null;
            return new QueueInfoDto
            {
                Name = queueName,
                ActiveMessageCount = known?.ActiveMessageCount ?? 0,
                DeadLetterMessageCount = known?.DeadLetterMessageCount ?? 0,
                ActiveCountExact = known?.ActiveCountExact ?? false,
                DeadLetterCountExact = known?.DeadLetterCountExact ?? false,
                IsEmulator = true
            };
        }

        var adminClient = GetManagementClient(connection);
        try
        {
            var props = await adminClient.GetQueueRuntimePropertiesAsync(queueName);
            return new QueueInfoDto
            {
                Name = props.Value.Name,
                ActiveMessageCount = props.Value.ActiveMessageCount,
                DeadLetterMessageCount = props.Value.DeadLetterMessageCount,
                IsEmulator = connection.IsEmulator
            };
        }
        catch
        {
            return null;
        }
    }

    public async Task<SubscriptionInfoDto?> GetSubscriptionRuntimeInfoAsync(int connectionId, string topicName, string subscriptionName, bool recount = false, CancellationToken cancellationToken = default)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        // Same as GetQueueRuntimeInfoAsync: last-known counts, no scan started here.
        if (connection.IsEmulator)
        {
            if (recount)
            {
                await _countRefresher.CountEntityNowAsync(connection, topicName, subscriptionName, cancellationToken);
            }

            var known = _entityCache.TryGet(connectionId, out var cached)
                ? cached.Topics.FirstOrDefault(t => t.Name == topicName)?.Subscriptions.FirstOrDefault(sub => sub.Name == subscriptionName)
                : null;
            return new SubscriptionInfoDto
            {
                Name = subscriptionName,
                ActiveMessageCount = known?.ActiveMessageCount ?? 0,
                DeadLetterMessageCount = known?.DeadLetterMessageCount ?? 0,
                ActiveCountExact = known?.ActiveCountExact ?? false,
                DeadLetterCountExact = known?.DeadLetterCountExact ?? false
            };
        }

        var adminClient = GetManagementClient(connection);
        try
        {
            var props = await adminClient.GetSubscriptionRuntimePropertiesAsync(topicName, subscriptionName);
            return new SubscriptionInfoDto
            {
                Name = props.Value.SubscriptionName,
                ActiveMessageCount = props.Value.ActiveMessageCount,
                DeadLetterMessageCount = props.Value.DeadLetterMessageCount
            };
        }
        catch
        {
            return null;
        }
    }

    public async Task<List<ServiceBusMessageDto>?> PeekMessagesAsync(int connectionId, string entityPath, string? subscriptionName, int maxMessages, bool deadLetter, long? fromSequenceNumber = null)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);
        ServiceBusReceiver receiver;

        if (subscriptionName != null)
        {
            receiver = client.CreateReceiver(entityPath, subscriptionName, new ServiceBusReceiverOptions { SubQueue = deadLetter ? SubQueue.DeadLetter : SubQueue.None });
        }
        else
        {
            receiver = client.CreateReceiver(entityPath, new ServiceBusReceiverOptions { SubQueue = deadLetter ? SubQueue.DeadLetter : SubQueue.None });
        }

        await using (receiver)
        {
            // PeekMessagesAsync is best-effort and may return fewer messages than requested
            // Loop until we get maxMessages or no more messages are available
            var allMessages = new List<ServiceBusReceivedMessage>();
            long? nextSequenceNumber = fromSequenceNumber;

            while (allMessages.Count < maxMessages)
            {
                var batch = nextSequenceNumber.HasValue
                    ? await receiver.PeekMessagesAsync(maxMessages - allMessages.Count, nextSequenceNumber.Value)
                    : await receiver.PeekMessagesAsync(maxMessages - allMessages.Count);

                if (batch.Count == 0)
                {
                    break;
                }

                allMessages.AddRange(batch);
                nextSequenceNumber = batch[batch.Count - 1].SequenceNumber + 1;
            }

            return allMessages.OrderBy(m => m.SequenceNumber).Select(MapToDto).ToList();
        }
    }

    public async Task<SessionScanResultDto?> ScanSessionsAsync(int connectionId, string entityPath, string? subscriptionName, bool deadLetter, long? fromSequenceNumber, int scanLimit)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);
        await using var receiver = CreateBrowseReceiver(client, entityPath, subscriptionName, deadLetter);

        // Peek (read-only browse) one page of up to scanLimit messages and group them by
        // session id. Peek never locks a session, so this is safe against live consumers.
        var groups = new Dictionary<string, SessionInfoDto>(StringComparer.Ordinal);
        var scanned = 0;
        long? lastSequenceNumber = null;
        long? nextSequenceNumber = fromSequenceNumber;
        var reachedEnd = false;

        while (scanned < scanLimit)
        {
            var batch = nextSequenceNumber.HasValue
                ? await receiver.PeekMessagesAsync(scanLimit - scanned, nextSequenceNumber.Value)
                : await receiver.PeekMessagesAsync(scanLimit - scanned);

            // Peek is best-effort; only an empty batch means there is nothing more to page through.
            if (batch.Count == 0)
            {
                reachedEnd = true;
                break;
            }

            foreach (var msg in batch)
            {
                var sessionId = msg.SessionId ?? string.Empty;
                if (!groups.TryGetValue(sessionId, out var info))
                {
                    info = new SessionInfoDto { SessionId = sessionId };
                    groups[sessionId] = info;
                }
                info.MessageCount++;
                if (!info.LastEnqueuedTime.HasValue || msg.EnqueuedTime > info.LastEnqueuedTime.Value)
                {
                    info.LastEnqueuedTime = msg.EnqueuedTime;
                }
            }

            scanned += batch.Count;
            lastSequenceNumber = batch[batch.Count - 1].SequenceNumber;
            nextSequenceNumber = lastSequenceNumber + 1;
        }

        return new SessionScanResultDto
        {
            Sessions = groups.Values.OrderBy(s => s.SessionId, StringComparer.Ordinal).ToList(),
            ScannedCount = scanned,
            LastSequenceNumber = lastSequenceNumber,
            ReachedEnd = reachedEnd
        };
    }

    public async Task<SessionMessageScanResultDto?> PeekSessionMessagesAsync(int connectionId, string entityPath, string? subscriptionName, string sessionId, bool deadLetter, long? fromSequenceNumber, int scanLimit)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);
        await using var receiver = CreateBrowseReceiver(client, entityPath, subscriptionName, deadLetter);

        // Peek one page and keep only the messages for the requested session. Filtering a
        // peeked window (rather than accepting a session receiver) keeps this fully read-only.
        var matches = new List<ServiceBusMessageDto>();
        var scanned = 0;
        long? lastSequenceNumber = null;
        long? nextSequenceNumber = fromSequenceNumber;
        var reachedEnd = false;

        while (scanned < scanLimit)
        {
            var batch = nextSequenceNumber.HasValue
                ? await receiver.PeekMessagesAsync(scanLimit - scanned, nextSequenceNumber.Value)
                : await receiver.PeekMessagesAsync(scanLimit - scanned);

            if (batch.Count == 0)
            {
                reachedEnd = true;
                break;
            }

            foreach (var msg in batch)
            {
                if (string.Equals(msg.SessionId ?? string.Empty, sessionId, StringComparison.Ordinal))
                {
                    matches.Add(MapToDto(msg));
                }
            }

            scanned += batch.Count;
            lastSequenceNumber = batch[batch.Count - 1].SequenceNumber;
            nextSequenceNumber = lastSequenceNumber + 1;
        }

        return new SessionMessageScanResultDto
        {
            Messages = matches,
            ScannedCount = scanned,
            LastSequenceNumber = lastSequenceNumber,
            ReachedEnd = reachedEnd
        };
    }

    // Bulk consume/purge: removes up to maxMessages from the front of the entity (oldest first).
    // Returns the exact number of messages actually completed (deleted), or null if the connection
    // is unknown. Guarantees it never deletes more than requested:
    //   * Each batch requests exactly the outstanding remainder and is completed atomically; the
    //     cancellation token (RequestAborted) is only checked *between* batches, so a client
    //     disconnect stops further deletion without half-finishing a batch or overshooting.
    //   * Messages whose lock is lost mid-complete are not counted and are retried on a later pass.
    public async Task<int?> ReceiveMessagesAsync(int connectionId, string entityPath, string? subscriptionName, int maxMessages, bool deadLetter, CancellationToken cancellationToken = default)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var subQueue = deadLetter ? SubQueue.DeadLetter : SubQueue.None;
        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);

        // A session-enabled entity rejects plain receivers, so the whole consume has to go through
        // locked sessions instead (see ConsumeSessionMessagesAsync). A null result means the path
        // doesn't take session receivers after all (emulator dead-letter sub-queues) — use a plain one.
        if (await RequiresSessionAsync(connection, entityPath, subscriptionName))
        {
            var sessionTimeoutSeconds = await _settingsService.GetBatchOperationTimeoutSecondsAsync();
            var sessionConsumed = await ConsumeSessionMessagesAsync(client, GetReceiverPath(entityPath, subscriptionName, deadLetter), maxMessages, DateTime.UtcNow + TimeSpan.FromSeconds(sessionTimeoutSeconds), cancellationToken);
            if (sessionConsumed.HasValue)
            {
                return sessionConsumed;
            }
        }

        // PrefetchCount = 0 so the broker never hands us more than we ask for; prefetched-but-unwanted
        // messages would otherwise have their locks expire and skew the count.
        var receiverOptions = new ServiceBusReceiverOptions { SubQueue = subQueue, PrefetchCount = 0 };
        ServiceBusReceiver receiver = subscriptionName != null
            ? client.CreateReceiver(entityPath, subscriptionName, receiverOptions)
            : client.CreateReceiver(entityPath, receiverOptions);

        await using (receiver)
        {
            var consumed = 0;
            var remaining = maxMessages;
            var timeoutSeconds = await _settingsService.GetBatchOperationTimeoutSecondsAsync();
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(timeoutSeconds);

            while (remaining > 0 && DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
            {
                var batchSize = Math.Min(remaining, 256);
                IReadOnlyList<ServiceBusReceivedMessage> messages;
                try
                {
                    // Receive from the front of the entity (FIFO by sequence number): the "first N".
                    messages = await receiver.ReceiveMessagesAsync(batchSize, TimeSpan.FromSeconds(5), cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // Consume is best-effort: if another consumer contends the entity and the receive
                    // itself fails (link detached, transient AMQP error, etc.), stop and return what we
                    // already consumed rather than surfacing an error for the whole operation.
                    _logger.LogWarning(ex, "Receive failed while consuming from {Entity}; returning {Consumed} consumed so far", entityPath, consumed);
                    break;
                }

                if (messages.Count == 0)
                    break;

                // Complete the batch in parallel - a 200-message consume is ~1 round-trip instead of
                // 200 sequential ones, so it finishes fast enough not to trip a client/proxy timeout.
                // Count only messages that actually completed; anything that fails (lock lost because
                // another consumer grabbed it, already settled, etc.) is skipped best-effort.
                var completeResults = await Task.WhenAll(messages.Select(async msg =>
                {
                    try
                    {
                        await receiver.CompleteMessageAsync(msg, cancellationToken);
                        return true;
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        return false;
                    }
                }));

                consumed += completeResults.Count(ok => ok);
                remaining = maxMessages - consumed;
            }

            return consumed;
        }
    }

    public async Task<int?> ReceiveMessagesBySequenceAsync(int connectionId, string entityPath, string? subscriptionName, IEnumerable<long> sequenceNumbers, bool deadLetter, CancellationToken cancellationToken = default)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var sequenceSet = new HashSet<long>(sequenceNumbers);
        if (sequenceSet.Count == 0)
        {
            return 0;
        }

        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);

        if (await RequiresSessionAsync(connection, entityPath, subscriptionName))
        {
            var sessionTimeoutSeconds = await _settingsService.GetBatchOperationTimeoutSecondsAsync();
            var sessionCompleted = await CompleteSessionMessagesBySequenceAsync(client, GetReceiverPath(entityPath, subscriptionName, deadLetter), sequenceSet, DateTime.UtcNow + TimeSpan.FromSeconds(sessionTimeoutSeconds), cancellationToken);
            if (sessionCompleted.HasValue)
            {
                return sessionCompleted;
            }
        }

        var receiverOptions = new ServiceBusReceiverOptions { SubQueue = deadLetter ? SubQueue.DeadLetter : SubQueue.None, PrefetchCount = 0 };
        ServiceBusReceiver receiver = subscriptionName != null
            ? client.CreateReceiver(entityPath, subscriptionName, receiverOptions)
            : client.CreateReceiver(entityPath, receiverOptions);

        await using (receiver)
        {
            const int batchSize = 256;
            var completed = 0;
            var timeoutSeconds = await _settingsService.GetBatchOperationTimeoutSecondsAsync();
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(timeoutSeconds);

            while (sequenceSet.Count > 0 && DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
            {
                IReadOnlyList<ServiceBusReceivedMessage> received;
                try
                {
                    received = await receiver.ReceiveMessagesAsync(batchSize, TimeSpan.FromSeconds(1), cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // Best-effort: if another consumer contends the entity and the receive fails, stop
                    // and return what we already completed rather than failing the whole operation.
                    _logger.LogWarning(ex, "Receive failed while deleting by sequence from {Entity}; returning {Completed} completed so far", entityPath, completed);
                    break;
                }

                if (received.Count == 0)
                {
                    break;
                }

                var toComplete = new List<ServiceBusReceivedMessage>();
                var toAbandon = new List<ServiceBusReceivedMessage>();

                foreach (var msg in received)
                {
                    if (sequenceSet.Contains(msg.SequenceNumber))
                    {
                        toComplete.Add(msg);
                        sequenceSet.Remove(msg.SequenceNumber);
                    }
                    else
                    {
                        toAbandon.Add(msg);
                    }
                }

                // Complete and abandon in parallel for speed. Both are best-effort: a message whose lock
                // was lost to another consumer (or already settled) is skipped rather than aborting the
                // batch. Count only messages that actually completed.
                var completeResults = await Task.WhenAll(toComplete.Select(async m =>
                {
                    try
                    {
                        await receiver.CompleteMessageAsync(m, cancellationToken);
                        return true;
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        return false;
                    }
                }));

                await Task.WhenAll(toAbandon.Select(async m =>
                {
                    try
                    {
                        await receiver.AbandonMessageAsync(m, cancellationToken: cancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // Abandoning a lock we no longer hold is harmless; ignore.
                    }
                }));

                completed += completeResults.Count(ok => ok);
            }
            return completed;
        }
    }

    public async Task<int?> CancelScheduledMessagesAsync(int connectionId, string entityPath, IEnumerable<long> sequenceNumbers)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var sequences = sequenceNumbers.Distinct().ToList();
        if (sequences.Count == 0)
        {
            return 0;
        }

        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);
        await using var sender = client.CreateSender(entityPath);

        // Cancelling a scheduled message removes it before its enqueue time. Each cancel is
        // independent; tolerate individual failures (e.g. a message that already fired) so one
        // bad sequence number doesn't abort the whole batch.
        var cancelled = 0;
        foreach (var sequenceNumber in sequences)
        {
            try
            {
                await sender.CancelScheduledMessageAsync(sequenceNumber);
                cancelled++;
            }
            catch (ServiceBusException)
            {
                // Message no longer schedulable (already enqueued or cancelled) — skip it.
            }
        }
        return cancelled;
    }

    public async Task<bool> SendMessageAsync(int connectionId, string entityPath, SendMessageDto dto)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);
        await using var sender = client.CreateSender(entityPath);
        var message = CreateServiceBusMessage(dto);
        await sender.SendMessageAsync(message);
        return true;
    }

    // Sends `count` identical copies of the message, packed into as few AMQP transfers as
    // possible via ServiceBusMessageBatch. Returns the number of messages sent, or null when
    // the connection is unknown.
    public async Task<int?> SendMessagesAsync(int connectionId, string entityPath, SendMessageDto dto, int count)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);
        await using var sender = client.CreateSender(entityPath);

        var sent = 0;
        while (sent < count)
        {
            using var batch = await sender.CreateMessageBatchAsync();
            // Always place at least one message in the batch; if a single message doesn't fit,
            // fall back to sending it on its own so we never loop forever.
            if (!batch.TryAddMessage(CreateServiceBusMessage(dto)))
            {
                await sender.SendMessageAsync(CreateServiceBusMessage(dto));
                sent++;
                continue;
            }
            var batchCount = 1;
            while (sent + batchCount < count && batch.TryAddMessage(CreateServiceBusMessage(dto)))
            {
                batchCount++;
            }
            await sender.SendMessagesAsync(batch);
            sent += batchCount;
        }
        return sent;
    }

    private static ServiceBusMessage CreateServiceBusMessage(SendMessageDto dto)
    {
        var message = new ServiceBusMessage(dto.Body)
        {
            ContentType = dto.ContentType ?? "application/json"
        };
        if (!string.IsNullOrEmpty(dto.Subject))
        {
            message.Subject = dto.Subject;
        }
        if (!string.IsNullOrEmpty(dto.MessageId))
        {
            message.MessageId = dto.MessageId;
        }
        if (!string.IsNullOrEmpty(dto.CorrelationId))
        {
            message.CorrelationId = dto.CorrelationId;
        }
        if (!string.IsNullOrEmpty(dto.ReplyTo))
        {
            message.ReplyTo = dto.ReplyTo;
        }
        if (!string.IsNullOrEmpty(dto.ReplyToSessionId))
        {
            message.ReplyToSessionId = dto.ReplyToSessionId;
        }
        if (!string.IsNullOrEmpty(dto.SessionId))
        {
            message.SessionId = dto.SessionId;
        }
        if (!string.IsNullOrEmpty(dto.To))
        {
            message.To = dto.To;
        }
        if (dto.ScheduledEnqueueTime.HasValue)
        {
            message.ScheduledEnqueueTime = dto.ScheduledEnqueueTime.Value;
        }
        if (dto.TimeToLive.HasValue)
        {
            message.TimeToLive = dto.TimeToLive.Value;
        }
        if (dto.ApplicationProperties != null)
        {
            var (valid, error) = ApplicationPropertyConverter.TryConvertAll(dto.ApplicationProperties, out var converted);
            if (!valid)
            {
                throw new ArgumentException(error);
            }
            foreach (var kvp in converted!)
            {
                message.ApplicationProperties[kvp.Key] = kvp.Value;
            }
        }
        return message;
    }

    private static ServiceBusMessageDto MapToDto(ServiceBusReceivedMessage msg)
    {
        return new ServiceBusMessageDto
        {
            MessageId = msg.MessageId,
            Body = msg.Body.ToString(),
            ContentType = msg.ContentType,
            Subject = msg.Subject,
            CorrelationId = msg.CorrelationId,
            ReplyTo = msg.ReplyTo,
            ReplyToSessionId = msg.ReplyToSessionId,
            SessionId = msg.SessionId,
            To = msg.To,
            SequenceNumber = msg.SequenceNumber,
            EnqueuedTime = msg.EnqueuedTime,
            // Non-scheduled messages report a sentinel rather than null — real Service Bus uses
            // DateTimeOffset.MinValue (year 0001), the emulator uses the Unix epoch (1970). Treat
            // anything at or before the epoch as "not scheduled" so the UI shows no bogus schedule.
            ScheduledEnqueueTime = msg.ScheduledEnqueueTime > DateTimeOffset.UnixEpoch ? msg.ScheduledEnqueueTime : null,
            State = msg.State.ToString(),
            TimeToLive = msg.TimeToLive,
            ExpiresAt = msg.ExpiresAt,
            DeliveryCount = msg.DeliveryCount,
            DeadLetterReason = msg.DeadLetterReason,
            DeadLetterErrorDescription = msg.DeadLetterErrorDescription,
            DeadLetterSource = msg.DeadLetterSource,
            ApplicationProperties = msg.ApplicationProperties.ToDictionary(k => k.Key, v => v.Value),
            ApplicationPropertyTypes = msg.ApplicationProperties.ToDictionary(k => k.Key, v => ApplicationPropertyConverter.TypeNameOf(v.Value))
        };
    }

    private static ServiceBusReceiver CreateBrowseReceiver(ServiceBusClient client, string entityPath, string? subscriptionName, bool deadLetter)
    {
        var options = new ServiceBusReceiverOptions { SubQueue = deadLetter ? SubQueue.DeadLetter : SubQueue.None };
        return subscriptionName != null
            ? client.CreateReceiver(entityPath, subscriptionName, options)
            : client.CreateReceiver(entityPath, options);
    }

    private static string GetReceiverPath(string entityPath, string? subscriptionName, bool deadLetter)
    {
        if (subscriptionName != null)
        {
            return $"{entityPath}/Subscriptions/{subscriptionName}" + (deadLetter ? "/$deadletterqueue" : "");
        }
        return entityPath + (deadLetter ? "/$deadletterqueue" : "");
    }

    // How long to wait for the broker to hand over the next session before concluding there are no
    // more. AcceptNextSessionAsync otherwise blocks for the client's TryTimeout (60s by default).
    private static readonly TimeSpan SessionAcceptTimeout = TimeSpan.FromSeconds(5);

    // True when messages of this entity can only be received through a locked session. The entity
    // cache already carries the flag for every enumerated entity; the admin lookup is the fallback
    // for a cold cache.
    private async Task<bool> RequiresSessionAsync(ServiceBusConnection connection, string entityPath, string? subscriptionName)
    {
        if (_entityCache.TryGet(connection.Id, out var cached))
        {
            if (subscriptionName == null)
            {
                var queue = cached.Queues.FirstOrDefault(q => string.Equals(q.Name, entityPath, StringComparison.OrdinalIgnoreCase));
                if (queue != null) return queue.RequiresSession;
            }
            else
            {
                var subscription = cached.Topics
                    .FirstOrDefault(t => string.Equals(t.Name, entityPath, StringComparison.OrdinalIgnoreCase))?
                    .Subscriptions.FirstOrDefault(s => string.Equals(s.Name, subscriptionName, StringComparison.OrdinalIgnoreCase));
                if (subscription != null) return subscription.RequiresSession;
            }
        }

        try
        {
            var adminClient = GetManagementClient(connection);
            return subscriptionName == null
                ? (await adminClient.GetQueueAsync(entityPath)).Value.RequiresSession
                : (await adminClient.GetSubscriptionAsync(entityPath, subscriptionName)).Value.RequiresSession;
        }
        catch (Exception ex)
        {
            // Can't tell — assume a plain entity, which is what the receive path did before.
            _logger.LogWarning(ex, "Could not determine whether {Entity} requires sessions; assuming it does not", entityPath);
            return false;
        }
    }

    private enum SessionAcceptOutcome
    {
        Accepted,
        // No session became available within SessionAcceptTimeout: everything left is either
        // empty or locked by another consumer.
        None,
        // The path refuses session receivers. Real Service Bus makes the dead-letter queue of a
        // session-enabled entity session-enabled too, but the emulator rejects sessions on
        // sub-queues, so callers fall back to a plain receiver.
        NotSupported
    }

    // Locks the next available session on the given path.
    private async Task<(ServiceBusSessionReceiver? Receiver, SessionAcceptOutcome Outcome)> TryAcceptNextSessionAsync(ServiceBusClient client, string path, CancellationToken cancellationToken)
    {
        // PrefetchCount = 0 for the same reason as the plain receivers: never hold locks on
        // messages we didn't ask for.
        var options = new ServiceBusSessionReceiverOptions { PrefetchCount = 0 };
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(SessionAcceptTimeout);

        try
        {
            return (await client.AcceptNextSessionAsync(path, options, timeoutSource.Token), SessionAcceptOutcome.Accepted);
        }
        catch (ServiceBusException ex) when (ex.Reason == ServiceBusFailureReason.ServiceTimeout)
        {
            return (null, SessionAcceptOutcome.None);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return (null, SessionAcceptOutcome.None);
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogDebug(ex, "{Entity} does not accept session receivers; falling back to a plain receiver", path);
            return (null, SessionAcceptOutcome.NotSupported);
        }
    }

    // Session equivalent of the bulk consume: sessions are locked one at a time, drained, released,
    // and the next one is taken, until maxMessages are gone or no session is left to lock.
    // Returns null when the path turns out not to accept session receivers at all, so the caller
    // can fall back to a plain one.
    private async Task<int?> ConsumeSessionMessagesAsync(ServiceBusClient client, string path, int maxMessages, DateTime deadline, CancellationToken cancellationToken)
    {
        var consumed = 0;
        var visited = new HashSet<string>(StringComparer.Ordinal);

        while (consumed < maxMessages && DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
        {
            var (receiver, outcome) = await TryAcceptNextSessionAsync(client, path, cancellationToken);
            if (outcome == SessionAcceptOutcome.NotSupported)
            {
                return consumed > 0 ? consumed : null;
            }
            if (receiver == null)
            {
                break;
            }

            await using (receiver)
            {
                // Sessions are drained before being released, so getting one back means the broker
                // has cycled through every available session — stop instead of spinning.
                if (!visited.Add(receiver.SessionId))
                {
                    break;
                }

                var sessionFailed = false;
                while (consumed < maxMessages && DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
                {
                    IReadOnlyList<ServiceBusReceivedMessage> messages;
                    try
                    {
                        messages = await receiver.ReceiveMessagesAsync(Math.Min(maxMessages - consumed, 256), TimeSpan.FromSeconds(5), cancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // Same best-effort contract as the plain path: report what was consumed.
                        _logger.LogWarning(ex, "Receive failed while consuming session {SessionId} of {Entity}; returning {Consumed} consumed so far", receiver.SessionId, path, consumed);
                        sessionFailed = true;
                        break;
                    }

                    if (messages.Count == 0)
                    {
                        break;
                    }

                    consumed += await CompleteAllAsync(receiver, messages, cancellationToken);
                }

                if (sessionFailed)
                {
                    break;
                }
            }
        }

        return consumed;
    }

    // Session equivalent of the delete-by-sequence flow. Messages that aren't targets are left
    // locked rather than abandoned: abandoning inside a session makes the broker redeliver them
    // immediately, which would loop forever. Closing the session releases them untouched.
    // Returns null when the path turns out not to accept session receivers at all, so the caller
    // can fall back to a plain one.
    private async Task<int?> CompleteSessionMessagesBySequenceAsync(ServiceBusClient client, string path, HashSet<long> sequenceSet, DateTime deadline, CancellationToken cancellationToken)
    {
        var completed = 0;
        var visited = new HashSet<string>(StringComparer.Ordinal);

        while (sequenceSet.Count > 0 && DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
        {
            var (receiver, outcome) = await TryAcceptNextSessionAsync(client, path, cancellationToken);
            if (outcome == SessionAcceptOutcome.NotSupported)
            {
                return completed > 0 ? completed : null;
            }
            if (receiver == null)
            {
                break;
            }

            await using (receiver)
            {
                if (!visited.Add(receiver.SessionId))
                {
                    break;
                }

                var sessionFailed = false;
                while (sequenceSet.Count > 0 && DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
                {
                    IReadOnlyList<ServiceBusReceivedMessage> received;
                    try
                    {
                        received = await receiver.ReceiveMessagesAsync(256, TimeSpan.FromSeconds(1), cancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.LogWarning(ex, "Receive failed while deleting by sequence from session {SessionId} of {Entity}; returning {Completed} completed so far", receiver.SessionId, path, completed);
                        sessionFailed = true;
                        break;
                    }

                    if (received.Count == 0)
                    {
                        break;
                    }

                    var toComplete = new List<ServiceBusReceivedMessage>();
                    foreach (var msg in received)
                    {
                        if (sequenceSet.Remove(msg.SequenceNumber))
                        {
                            toComplete.Add(msg);
                        }
                    }

                    completed += await CompleteAllAsync(receiver, toComplete, cancellationToken);
                }

                if (sessionFailed)
                {
                    break;
                }
            }
        }

        return completed;
    }

    // Completes a batch in parallel and returns how many actually settled. Anything that fails
    // (lock lost to another consumer, already settled) is skipped best-effort.
    private static async Task<int> CompleteAllAsync(ServiceBusReceiver receiver, IReadOnlyList<ServiceBusReceivedMessage> messages, CancellationToken cancellationToken)
    {
        if (messages.Count == 0)
        {
            return 0;
        }

        var results = await Task.WhenAll(messages.Select(async msg =>
        {
            try
            {
                await receiver.CompleteMessageAsync(msg, cancellationToken);
                return true;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return false;
            }
        }));

        return results.Count(ok => ok);
    }

    public async Task<bool?> ReturnDeadLetterMessageAsync(int connectionId, string entityPath, string? subscriptionName, long sequenceNumber, SendMessageDto? modifiedMessage, bool deleteOriginal)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);
        ServiceBusReceiver dlqReceiver;

        if (subscriptionName != null)
        {
            dlqReceiver = client.CreateReceiver(entityPath, subscriptionName, new ServiceBusReceiverOptions { SubQueue = SubQueue.DeadLetter, PrefetchCount = 0 });
        }
        else
        {
            dlqReceiver = client.CreateReceiver(entityPath, new ServiceBusReceiverOptions { SubQueue = SubQueue.DeadLetter, PrefetchCount = 0 });
        }

        await using (dlqReceiver)
        {
            var message = await dlqReceiver.PeekMessageAsync(sequenceNumber);
            if (message == null)
            {
                return false;
            }

            await using var sender = client.CreateSender(entityPath);
            if (modifiedMessage != null)
            {
                await sender.SendMessageAsync(CreateServiceBusMessage(modifiedMessage));
            }
            else
            {
                var newMessage = new ServiceBusMessage(message);
                await sender.SendMessageAsync(newMessage);
            }

            if (deleteOriginal)
            {
                // The dead-letter queue of a session-enabled entity is session-enabled too on real
                // Service Bus, so the original can only be settled through a locked session. The
                // emulator rejects sessions on sub-queues, which falls through to the plain flow.
                if (await RequiresSessionAsync(connection, entityPath, subscriptionName))
                {
                    var timeoutSeconds = await _settingsService.GetBatchOperationTimeoutSecondsAsync();
                    var sessionCompleted = await CompleteSessionMessagesBySequenceAsync(client, GetReceiverPath(entityPath, subscriptionName, deadLetter: true), new HashSet<long> { sequenceNumber }, DateTime.UtcNow + TimeSpan.FromSeconds(timeoutSeconds), CancellationToken.None);
                    if (sessionCompleted.HasValue)
                    {
                        return true;
                    }
                }

                // Use larger batch sizes for faster iteration through DLQ
                // Max batch size is 256 for Service Bus
                const int batchSize = 256;
                var maxAttempts = 50; // More attempts to handle deep messages

                for (var attempt = 0; attempt < maxAttempts; attempt++)
                {
                    var received = await dlqReceiver.ReceiveMessagesAsync(batchSize, TimeSpan.FromSeconds(1));
                    if (received.Count == 0)
                    {
                        break;
                    }

                    ServiceBusReceivedMessage? toComplete = null;
                    var toAbandon = new List<ServiceBusReceivedMessage>();

                    foreach (var msg in received)
                    {
                        if (msg.SequenceNumber == sequenceNumber)
                        {
                            toComplete = msg;
                        }
                        else
                        {
                            toAbandon.Add(msg);
                        }
                    }

                    // Abandon non-target messages in parallel for speed
                    if (toAbandon.Count > 0)
                    {
                        await Task.WhenAll(toAbandon.Select(m => dlqReceiver.AbandonMessageAsync(m)));
                    }

                    if (toComplete != null)
                    {
                        await dlqReceiver.CompleteMessageAsync(toComplete);
                        return true;
                    }
                }
            }
            return true;
        }
    }

    public async Task<int?> ReturnDeadLetterMessagesAsync(int connectionId, string entityPath, string? subscriptionName, IEnumerable<long> sequenceNumbers)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var sequenceSet = new HashSet<long>(sequenceNumbers);
        if (sequenceSet.Count == 0)
        {
            return 0;
        }

        var client = _clientCache.GetClient(connectionId, connection.ConnectionString);
        ServiceBusReceiver dlqReceiver;

        if (subscriptionName != null)
        {
            dlqReceiver = client.CreateReceiver(entityPath, subscriptionName, new ServiceBusReceiverOptions { SubQueue = SubQueue.DeadLetter, PrefetchCount = 0 });
        }
        else
        {
            dlqReceiver = client.CreateReceiver(entityPath, new ServiceBusReceiverOptions { SubQueue = SubQueue.DeadLetter, PrefetchCount = 0 });
        }

        await using (dlqReceiver)
        {
            await using var sender = client.CreateSender(entityPath);

            // Peek all the messages we need to return in parallel
            var peekTasks = sequenceSet.Select(async seqNum =>
            {
                var peeked = await dlqReceiver.PeekMessageAsync(seqNum);
                return peeked != null ? (SeqNum: seqNum, Message: new ServiceBusMessage(peeked)) : ((long SeqNum, ServiceBusMessage Message)?)(null);
            });
            var peekResults = await Task.WhenAll(peekTasks);
            var messagesToReturn = peekResults
                .Where(r => r.HasValue)
                .ToDictionary(r => r!.Value.SeqNum, r => r!.Value.Message);

            // Send all messages back to the main queue in parallel
            await Task.WhenAll(messagesToReturn.Values.Select(msg => sender.SendMessageAsync(msg)));

            // Now receive and complete the original DLQ messages
            // Use larger batch sizes for faster iteration
            const int batchSize = 256;
            var completed = 0;
            var timeoutSeconds = await _settingsService.GetBatchOperationTimeoutSecondsAsync();
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(timeoutSeconds);

            // The dead-letter queue of a session-enabled entity is session-enabled too on real
            // Service Bus, so the originals can only be settled through locked sessions. The
            // emulator rejects sessions on sub-queues, which falls through to the plain flow.
            if (await RequiresSessionAsync(connection, entityPath, subscriptionName))
            {
                var sessionCompleted = await CompleteSessionMessagesBySequenceAsync(client, GetReceiverPath(entityPath, subscriptionName, deadLetter: true), sequenceSet, deadline, CancellationToken.None);
                if (sessionCompleted.HasValue)
                {
                    return sessionCompleted;
                }
            }

            while (sequenceSet.Count > 0 && DateTime.UtcNow < deadline)
            {
                var received = await dlqReceiver.ReceiveMessagesAsync(batchSize, TimeSpan.FromSeconds(1));
                if (received.Count == 0)
                {
                    break;
                }

                var toComplete = new List<ServiceBusReceivedMessage>();
                var toAbandon = new List<ServiceBusReceivedMessage>();

                foreach (var msg in received)
                {
                    if (sequenceSet.Contains(msg.SequenceNumber))
                    {
                        toComplete.Add(msg);
                        sequenceSet.Remove(msg.SequenceNumber);
                    }
                    else
                    {
                        toAbandon.Add(msg);
                    }
                }

                // Complete and abandon in parallel for speed
                var tasks = new List<Task>();
                tasks.AddRange(toComplete.Select(m => dlqReceiver.CompleteMessageAsync(m)));
                tasks.AddRange(toAbandon.Select(m => dlqReceiver.AbandonMessageAsync(m)));
                await Task.WhenAll(tasks);

                completed += toComplete.Count;
            }
            return completed;
        }
    }

    public async Task<QueuePropertiesDto?> GetQueuePropertiesAsync(int connectionId, string queueName)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var adminClient = GetManagementClient(connection);
        var props = (await adminClient.GetQueueAsync(queueName)).Value;
        var dto = new QueuePropertiesDto
        {
            Name = props.Name,
            Status = props.Status.ToString(),
            DefaultMessageTimeToLive = props.DefaultMessageTimeToLive,
            LockDuration = props.LockDuration,
            AutoDeleteOnIdle = props.AutoDeleteOnIdle,
            DuplicateDetectionHistoryTimeWindow = props.DuplicateDetectionHistoryTimeWindow,
            MaxDeliveryCount = props.MaxDeliveryCount,
            RequiresDuplicateDetection = props.RequiresDuplicateDetection,
            RequiresSession = props.RequiresSession,
            DeadLetteringOnMessageExpiration = props.DeadLetteringOnMessageExpiration,
            EnableBatchedOperations = props.EnableBatchedOperations,
            EnablePartitioning = props.EnablePartitioning,
            ForwardTo = props.ForwardTo,
            ForwardDeadLetteredMessagesTo = props.ForwardDeadLetteredMessagesTo,
            MaxSizeInMegabytes = props.MaxSizeInMegabytes,
            MaxMessageSizeInKilobytes = props.MaxMessageSizeInKilobytes,
            UserMetadata = props.UserMetadata
        };

        // Runtime metrics live on a separate admin call; best-effort so a failure here
        // still returns the configuration above.
        try
        {
            var rt = (await adminClient.GetQueueRuntimePropertiesAsync(queueName)).Value;
            dto.TotalMessageCount = rt.TotalMessageCount;
            dto.ActiveMessageCount = rt.ActiveMessageCount;
            dto.DeadLetterMessageCount = rt.DeadLetterMessageCount;
            dto.ScheduledMessageCount = rt.ScheduledMessageCount;
            dto.TransferMessageCount = rt.TransferMessageCount;
            dto.TransferDeadLetterMessageCount = rt.TransferDeadLetterMessageCount;
            dto.SizeInBytes = rt.SizeInBytes;

            // The emulator's runtime properties are always zero; use the background-maintained
            // browse counts instead. Scheduled/transfer counts have no browse equivalent here and
            // stay zero.
            if (connection.IsEmulator && _entityCache.TryGet(connectionId, out var cached))
            {
                var known = cached.Queues.FirstOrDefault(q => q.Name == queueName);
                if (known != null)
                {
                    dto.ActiveMessageCount = known.ActiveMessageCount;
                    dto.DeadLetterMessageCount = known.DeadLetterMessageCount;
                    dto.TotalMessageCount = known.ActiveMessageCount + known.DeadLetterMessageCount;
                }
            }

            dto.CreatedAt = rt.CreatedAt;
            dto.UpdatedAt = rt.UpdatedAt;
            dto.AccessedAt = rt.AccessedAt;
        }
        catch (ServiceBusException)
        {
        }

        return dto;
    }

    public async Task<TopicPropertiesDto?> GetTopicPropertiesAsync(int connectionId, string topicName)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var adminClient = GetManagementClient(connection);
        var props = (await adminClient.GetTopicAsync(topicName)).Value;
        var dto = new TopicPropertiesDto
        {
            Name = props.Name,
            Status = props.Status.ToString(),
            DefaultMessageTimeToLive = props.DefaultMessageTimeToLive,
            AutoDeleteOnIdle = props.AutoDeleteOnIdle,
            DuplicateDetectionHistoryTimeWindow = props.DuplicateDetectionHistoryTimeWindow,
            RequiresDuplicateDetection = props.RequiresDuplicateDetection,
            EnableBatchedOperations = props.EnableBatchedOperations,
            EnablePartitioning = props.EnablePartitioning,
            SupportOrdering = props.SupportOrdering,
            MaxSizeInMegabytes = props.MaxSizeInMegabytes,
            MaxMessageSizeInKilobytes = props.MaxMessageSizeInKilobytes,
            UserMetadata = props.UserMetadata
        };

        try
        {
            var rt = (await adminClient.GetTopicRuntimePropertiesAsync(topicName)).Value;
            dto.SubscriptionCount = rt.SubscriptionCount;
            dto.ScheduledMessageCount = rt.ScheduledMessageCount;
            dto.SizeInBytes = rt.SizeInBytes;
            dto.CreatedAt = rt.CreatedAt;
            dto.UpdatedAt = rt.UpdatedAt;
            dto.AccessedAt = rt.AccessedAt;
        }
        catch (ServiceBusException)
        {
        }

        return dto;
    }

    public async Task<SubscriptionPropertiesDto?> GetSubscriptionPropertiesAsync(int connectionId, string topicName, string subscriptionName)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var adminClient = GetManagementClient(connection);
        var props = (await adminClient.GetSubscriptionAsync(topicName, subscriptionName)).Value;
        var dto = new SubscriptionPropertiesDto
        {
            Name = props.SubscriptionName,
            TopicName = props.TopicName,
            Status = props.Status.ToString(),
            DefaultMessageTimeToLive = props.DefaultMessageTimeToLive,
            LockDuration = props.LockDuration,
            AutoDeleteOnIdle = props.AutoDeleteOnIdle,
            MaxDeliveryCount = props.MaxDeliveryCount,
            RequiresSession = props.RequiresSession,
            DeadLetteringOnMessageExpiration = props.DeadLetteringOnMessageExpiration,
            DeadLetteringOnFilterEvaluationExceptions = props.EnableDeadLetteringOnFilterEvaluationExceptions,
            EnableBatchedOperations = props.EnableBatchedOperations,
            ForwardTo = props.ForwardTo,
            ForwardDeadLetteredMessagesTo = props.ForwardDeadLetteredMessagesTo,
            UserMetadata = props.UserMetadata
        };

        try
        {
            var rt = (await adminClient.GetSubscriptionRuntimePropertiesAsync(topicName, subscriptionName)).Value;
            dto.TotalMessageCount = rt.TotalMessageCount;
            dto.ActiveMessageCount = rt.ActiveMessageCount;
            dto.DeadLetterMessageCount = rt.DeadLetterMessageCount;
            dto.TransferMessageCount = rt.TransferMessageCount;
            dto.TransferDeadLetterMessageCount = rt.TransferDeadLetterMessageCount;

            // Same as GetQueuePropertiesAsync.
            if (connection.IsEmulator && _entityCache.TryGet(connectionId, out var cached))
            {
                var known = cached.Topics.FirstOrDefault(t => t.Name == topicName)?.Subscriptions.FirstOrDefault(sub => sub.Name == subscriptionName);
                if (known != null)
                {
                    dto.ActiveMessageCount = known.ActiveMessageCount;
                    dto.DeadLetterMessageCount = known.DeadLetterMessageCount;
                    dto.TotalMessageCount = known.ActiveMessageCount + known.DeadLetterMessageCount;
                }
            }

            dto.CreatedAt = rt.CreatedAt;
            dto.UpdatedAt = rt.UpdatedAt;
            dto.AccessedAt = rt.AccessedAt;
        }
        catch (ServiceBusException)
        {
        }

        return dto;
    }

    public async Task<List<SubscriptionRuleDto>?> GetSubscriptionRulesAsync(int connectionId, string topicName, string subscriptionName)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return null;

        var adminClient = GetManagementClient(connection);

        var rules = new List<SubscriptionRuleDto>();
        await foreach (var rule in adminClient.GetRulesAsync(topicName, subscriptionName))
        {
            rules.Add(MapRuleToDto(rule));
        }
        return rules;
    }

    private static SubscriptionRuleDto MapRuleToDto(RuleProperties rule)
    {
        var dto = new SubscriptionRuleDto { Name = rule.Name };

        // TrueRuleFilter and FalseRuleFilter both derive from SqlRuleFilter, so they must be
        // matched before the general SqlRuleFilter case.
        switch (rule.Filter)
        {
            case TrueRuleFilter:
                dto.FilterType = "True";
                break;
            case FalseRuleFilter:
                dto.FilterType = "False";
                break;
            case SqlRuleFilter sql:
                dto.FilterType = "Sql";
                dto.SqlFilter = sql.SqlExpression;
                break;
            case CorrelationRuleFilter cf:
                dto.FilterType = "Correlation";
                dto.CorrelationFilter = new CorrelationFilterDto
                {
                    CorrelationId = cf.CorrelationId,
                    MessageId = cf.MessageId,
                    To = cf.To,
                    ReplyTo = cf.ReplyTo,
                    Subject = cf.Subject,
                    SessionId = cf.SessionId,
                    ReplyToSessionId = cf.ReplyToSessionId,
                    ContentType = cf.ContentType,
                    ApplicationProperties = cf.ApplicationProperties.Count > 0
                        ? new Dictionary<string, object>(cf.ApplicationProperties)
                        : null
                };
                break;
            default:
                dto.FilterType = "Unknown";
                break;
        }

        if (rule.Action is SqlRuleAction action)
        {
            dto.Action = action.SqlExpression;
        }

        return dto;
    }

    public async Task<bool> CreateQueueAsync(int connectionId, CreateQueueDto dto)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var adminClient = GetManagementClient(connection);
        var options = new CreateQueueOptions(dto.Name);
        if (dto.DefaultMessageTimeToLive.HasValue)
        {
            options.DefaultMessageTimeToLive = dto.DefaultMessageTimeToLive.Value;
        }
        if (dto.LockDuration.HasValue)
        {
            options.LockDuration = dto.LockDuration.Value;
        }
        if (dto.MaxDeliveryCount.HasValue)
        {
            options.MaxDeliveryCount = dto.MaxDeliveryCount.Value;
        }
        if (dto.RequiresDuplicateDetection.HasValue)
        {
            options.RequiresDuplicateDetection = dto.RequiresDuplicateDetection.Value;
        }
        if (dto.RequiresSession.HasValue)
        {
            options.RequiresSession = dto.RequiresSession.Value;
        }
        if (dto.DeadLetteringOnMessageExpiration.HasValue)
        {
            options.DeadLetteringOnMessageExpiration = dto.DeadLetteringOnMessageExpiration.Value;
        }
        if (!string.IsNullOrEmpty(dto.ForwardTo))
        {
            options.ForwardTo = dto.ForwardTo;
        }
        if (!string.IsNullOrEmpty(dto.ForwardDeadLetteredMessagesTo))
        {
            options.ForwardDeadLetteredMessagesTo = dto.ForwardDeadLetteredMessagesTo;
        }
        if (dto.AutoDeleteOnIdle.HasValue)
        {
            options.AutoDeleteOnIdle = dto.AutoDeleteOnIdle.Value;
        }
        if (dto.DuplicateDetectionHistoryTimeWindow.HasValue)
        {
            options.DuplicateDetectionHistoryTimeWindow = dto.DuplicateDetectionHistoryTimeWindow.Value;
        }
        if (dto.MaxSizeInMegabytes.HasValue)
        {
            options.MaxSizeInMegabytes = dto.MaxSizeInMegabytes.Value;
        }
        if (dto.EnableBatchedOperations.HasValue)
        {
            options.EnableBatchedOperations = dto.EnableBatchedOperations.Value;
        }
        if (dto.EnablePartitioning.HasValue)
        {
            options.EnablePartitioning = dto.EnablePartitioning.Value;
        }
        if (!string.IsNullOrEmpty(dto.UserMetadata))
        {
            options.UserMetadata = dto.UserMetadata;
        }
        await adminClient.CreateQueueAsync(options);
        _entityCache.Invalidate(connectionId);
        return true;
    }

    public async Task<bool> CreateTopicAsync(int connectionId, CreateTopicDto dto)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var adminClient = GetManagementClient(connection);
        var options = new CreateTopicOptions(dto.Name);
        if (dto.DefaultMessageTimeToLive.HasValue)
        {
            options.DefaultMessageTimeToLive = dto.DefaultMessageTimeToLive.Value;
        }
        if (dto.RequiresDuplicateDetection.HasValue)
        {
            options.RequiresDuplicateDetection = dto.RequiresDuplicateDetection.Value;
        }
        if (dto.AutoDeleteOnIdle.HasValue)
        {
            options.AutoDeleteOnIdle = dto.AutoDeleteOnIdle.Value;
        }
        if (dto.DuplicateDetectionHistoryTimeWindow.HasValue)
        {
            options.DuplicateDetectionHistoryTimeWindow = dto.DuplicateDetectionHistoryTimeWindow.Value;
        }
        if (dto.MaxSizeInMegabytes.HasValue)
        {
            options.MaxSizeInMegabytes = dto.MaxSizeInMegabytes.Value;
        }
        if (dto.EnableBatchedOperations.HasValue)
        {
            options.EnableBatchedOperations = dto.EnableBatchedOperations.Value;
        }
        if (dto.EnablePartitioning.HasValue)
        {
            options.EnablePartitioning = dto.EnablePartitioning.Value;
        }
        if (dto.SupportOrdering.HasValue)
        {
            options.SupportOrdering = dto.SupportOrdering.Value;
        }
        if (!string.IsNullOrEmpty(dto.UserMetadata))
        {
            options.UserMetadata = dto.UserMetadata;
        }
        await adminClient.CreateTopicAsync(options);
        _entityCache.Invalidate(connectionId);
        return true;
    }

    public async Task<bool> CreateSubscriptionAsync(int connectionId, string topicName, CreateSubscriptionDto dto)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var adminClient = GetManagementClient(connection);
        var options = new CreateSubscriptionOptions(topicName, dto.Name);
        if (dto.DefaultMessageTimeToLive.HasValue)
        {
            options.DefaultMessageTimeToLive = dto.DefaultMessageTimeToLive.Value;
        }
        if (dto.LockDuration.HasValue)
        {
            options.LockDuration = dto.LockDuration.Value;
        }
        if (dto.MaxDeliveryCount.HasValue)
        {
            options.MaxDeliveryCount = dto.MaxDeliveryCount.Value;
        }
        if (dto.RequiresSession.HasValue)
        {
            options.RequiresSession = dto.RequiresSession.Value;
        }
        if (dto.DeadLetteringOnMessageExpiration.HasValue)
        {
            options.DeadLetteringOnMessageExpiration = dto.DeadLetteringOnMessageExpiration.Value;
        }
        if (!string.IsNullOrEmpty(dto.ForwardTo))
        {
            options.ForwardTo = dto.ForwardTo;
        }
        if (!string.IsNullOrEmpty(dto.ForwardDeadLetteredMessagesTo))
        {
            options.ForwardDeadLetteredMessagesTo = dto.ForwardDeadLetteredMessagesTo;
        }
        if (dto.AutoDeleteOnIdle.HasValue)
        {
            options.AutoDeleteOnIdle = dto.AutoDeleteOnIdle.Value;
        }
        if (dto.DeadLetteringOnFilterEvaluationExceptions.HasValue)
        {
            options.EnableDeadLetteringOnFilterEvaluationExceptions = dto.DeadLetteringOnFilterEvaluationExceptions.Value;
        }
        if (dto.EnableBatchedOperations.HasValue)
        {
            options.EnableBatchedOperations = dto.EnableBatchedOperations.Value;
        }
        if (!string.IsNullOrEmpty(dto.UserMetadata))
        {
            options.UserMetadata = dto.UserMetadata;
        }
        await adminClient.CreateSubscriptionAsync(options);
        _entityCache.Invalidate(connectionId);
        return true;
    }

    public async Task<bool> UpdateQueueAsync(int connectionId, string queueName, UpdateQueueDto dto)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var adminClient = GetManagementClient(connection);
        var props = await adminClient.GetQueueAsync(queueName);
        if (!string.IsNullOrEmpty(dto.Status))
        {
            props.Value.Status = dto.Status; // EntityStatus has implicit conversion from string
        }
        if (dto.DefaultMessageTimeToLive.HasValue)
        {
            props.Value.DefaultMessageTimeToLive = dto.DefaultMessageTimeToLive.Value;
        }
        if (dto.LockDuration.HasValue)
        {
            props.Value.LockDuration = dto.LockDuration.Value;
        }
        if (dto.MaxDeliveryCount.HasValue)
        {
            props.Value.MaxDeliveryCount = dto.MaxDeliveryCount.Value;
        }
        if (dto.DeadLetteringOnMessageExpiration.HasValue)
        {
            props.Value.DeadLetteringOnMessageExpiration = dto.DeadLetteringOnMessageExpiration.Value;
        }
        props.Value.ForwardTo = dto.ForwardTo;
        props.Value.ForwardDeadLetteredMessagesTo = dto.ForwardDeadLetteredMessagesTo;
        await adminClient.UpdateQueueAsync(props.Value);
        _entityCache.Invalidate(connectionId);
        return true;
    }

    public async Task<bool> UpdateTopicAsync(int connectionId, string topicName, UpdateTopicDto dto)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var adminClient = GetManagementClient(connection);
        var props = await adminClient.GetTopicAsync(topicName);
        if (!string.IsNullOrEmpty(dto.Status))
        {
            props.Value.Status = dto.Status; // EntityStatus has implicit conversion from string
        }
        if (dto.DefaultMessageTimeToLive.HasValue)
        {
            props.Value.DefaultMessageTimeToLive = dto.DefaultMessageTimeToLive.Value;
        }
        await adminClient.UpdateTopicAsync(props.Value);
        _entityCache.Invalidate(connectionId);
        return true;
    }

    public async Task<bool> UpdateSubscriptionAsync(int connectionId, string topicName, string subscriptionName, UpdateSubscriptionDto dto)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var adminClient = GetManagementClient(connection);
        var props = await adminClient.GetSubscriptionAsync(topicName, subscriptionName);
        if (!string.IsNullOrEmpty(dto.Status))
        {
            props.Value.Status = dto.Status; // EntityStatus has implicit conversion from string
        }
        if (dto.DefaultMessageTimeToLive.HasValue)
        {
            props.Value.DefaultMessageTimeToLive = dto.DefaultMessageTimeToLive.Value;
        }
        if (dto.LockDuration.HasValue)
        {
            props.Value.LockDuration = dto.LockDuration.Value;
        }
        if (dto.MaxDeliveryCount.HasValue)
        {
            props.Value.MaxDeliveryCount = dto.MaxDeliveryCount.Value;
        }
        if (dto.DeadLetteringOnMessageExpiration.HasValue)
        {
            props.Value.DeadLetteringOnMessageExpiration = dto.DeadLetteringOnMessageExpiration.Value;
        }
        props.Value.ForwardTo = dto.ForwardTo;
        props.Value.ForwardDeadLetteredMessagesTo = dto.ForwardDeadLetteredMessagesTo;
        await adminClient.UpdateSubscriptionAsync(props.Value);
        _entityCache.Invalidate(connectionId);
        return true;
    }

    public async Task<bool> DeleteQueueAsync(int connectionId, string queueName)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var adminClient = GetManagementClient(connection);
        await adminClient.DeleteQueueAsync(queueName);
        _entityCache.Invalidate(connectionId);
        return true;
    }

    public async Task<bool> DeleteTopicAsync(int connectionId, string topicName)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var adminClient = GetManagementClient(connection);
        await adminClient.DeleteTopicAsync(topicName);
        _entityCache.Invalidate(connectionId);
        return true;
    }

    public async Task<bool> DeleteSubscriptionAsync(int connectionId, string topicName, string subscriptionName)
    {
        var connection = await _connectionRepository.GetByIdAsync(connectionId);
        if (connection == null) return false;

        var adminClient = GetManagementClient(connection);
        await adminClient.DeleteSubscriptionAsync(topicName, subscriptionName);
        _entityCache.Invalidate(connectionId);
        return true;
    }
}
