using Vectora.Api.Models;

namespace Vectora.Api.Services;

public interface IServiceBusService
{
    Task<(List<QueueInfoDto> Queues, List<TopicInfoDto> Topics)?> GetEntitiesAsync(int connectionId, bool refreshCache = false, CancellationToken cancellationToken = default);
    Task<QueueInfoDto?> GetQueueRuntimeInfoAsync(int connectionId, string queueName, bool recount = false, CancellationToken cancellationToken = default);
    Task<SubscriptionInfoDto?> GetSubscriptionRuntimeInfoAsync(int connectionId, string topicName, string subscriptionName, bool recount = false, CancellationToken cancellationToken = default);
    Task<List<ServiceBusMessageDto>?> PeekMessagesAsync(int connectionId, string entityPath, string? subscriptionName, int maxMessages, bool deadLetter, long? fromSequenceNumber = null);
    Task<SessionScanResultDto?> ScanSessionsAsync(int connectionId, string entityPath, string? subscriptionName, bool deadLetter, long? fromSequenceNumber, int scanLimit);
    Task<SessionMessageScanResultDto?> PeekSessionMessagesAsync(int connectionId, string entityPath, string? subscriptionName, string sessionId, bool deadLetter, long? fromSequenceNumber, int scanLimit);
    Task<int?> ReceiveMessagesAsync(int connectionId, string entityPath, string? subscriptionName, int maxMessages, bool deadLetter, string? sessionId = null, CancellationToken cancellationToken = default);
    Task<int?> ReceiveMessagesBySequenceAsync(int connectionId, string entityPath, string? subscriptionName, IEnumerable<long> sequenceNumbers, bool deadLetter, CancellationToken cancellationToken = default);
    Task<int?> CancelScheduledMessagesAsync(int connectionId, string entityPath, IEnumerable<long> sequenceNumbers);
    Task<bool> SendMessageAsync(int connectionId, string entityPath, SendMessageDto message);
    Task<int?> SendMessagesAsync(int connectionId, string entityPath, SendMessageDto message, int count);
    Task<bool?> ReturnDeadLetterMessageAsync(int connectionId, string entityPath, string? subscriptionName, long sequenceNumber, SendMessageDto? modifiedMessage, bool deleteOriginal);
    Task<int?> ReturnDeadLetterMessagesAsync(int connectionId, string entityPath, string? subscriptionName, IEnumerable<long> sequenceNumbers);

    // Entity management - handles emulator vs real Service Bus internally
    Task<QueuePropertiesDto?> GetQueuePropertiesAsync(int connectionId, string queueName);
    Task<TopicPropertiesDto?> GetTopicPropertiesAsync(int connectionId, string topicName);
    Task<SubscriptionPropertiesDto?> GetSubscriptionPropertiesAsync(int connectionId, string topicName, string subscriptionName);
    Task<List<SubscriptionRuleDto>?> GetSubscriptionRulesAsync(int connectionId, string topicName, string subscriptionName);
    Task<bool> CreateQueueAsync(int connectionId, CreateQueueDto dto);
    Task<bool> CreateTopicAsync(int connectionId, CreateTopicDto dto);
    Task<bool> CreateSubscriptionAsync(int connectionId, string topicName, CreateSubscriptionDto dto);
    Task<bool> UpdateQueueAsync(int connectionId, string queueName, UpdateQueueDto dto);
    Task<bool> UpdateTopicAsync(int connectionId, string topicName, UpdateTopicDto dto);
    Task<bool> UpdateSubscriptionAsync(int connectionId, string topicName, string subscriptionName, UpdateSubscriptionDto dto);
    Task<bool> DeleteQueueAsync(int connectionId, string queueName);
    Task<bool> DeleteTopicAsync(int connectionId, string topicName);
    Task<bool> DeleteSubscriptionAsync(int connectionId, string topicName, string subscriptionName);
}

