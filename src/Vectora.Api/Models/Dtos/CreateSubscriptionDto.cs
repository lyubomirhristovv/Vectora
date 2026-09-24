namespace Vectora.Api.Models;

public class CreateSubscriptionDto
{
    public string Name { get; set; } = string.Empty;
    public TimeSpan? DefaultMessageTimeToLive { get; set; }
    public TimeSpan? LockDuration { get; set; }
    public TimeSpan? AutoDeleteOnIdle { get; set; }
    public int? MaxDeliveryCount { get; set; }
    public bool? RequiresSession { get; set; }
    public bool? DeadLetteringOnMessageExpiration { get; set; }
    public bool? DeadLetteringOnFilterEvaluationExceptions { get; set; }
    public bool? EnableBatchedOperations { get; set; }
    public string? ForwardTo { get; set; }
    public string? ForwardDeadLetteredMessagesTo { get; set; }
    public string? UserMetadata { get; set; }
}
