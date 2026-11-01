# AWS access for rented Mac testing

Use the AWS CLI profile **`agent-macos-test`**. It assumes **`MacOSTestOperator`** through the existing nonroot `agent-reserved-source` credentials. Root is not needed for normal provisioning, inspection, testing or cleanup.

The profile is saved in `~/.aws/config`. Its role policies, trust policies, account/network identifiers and permission-check receipts are saved privately in `~/.aws/aimgr-macos-test/` (directory mode `0700`, files `0600`). No new access key was created. Keep these private files and the source credentials out of this public repository and off the rented test host.

```bash
aws --profile agent-macos-test sts get-caller-identity
aws --profile agent-macos-test ec2 describe-hosts --region us-east-1
```

The returned identity must be an assumed session of `MacOSTestOperator`. AWS CLI renews the role session using its configured source profile. If that source credential is revoked or unavailable on another control machine, restore the approved source access; do not replace the profile with root.

## Permissions and resource ownership

Provision in `us-east-1`, using the inspected existing default VPC/subnets. Every created host, instance, volume, network interface, imported SSH key and security group must carry `Purpose=aimgr-macos-testing`. Launches are limited to Mac instance types on dedicated hosts, public Amazon-owned images, encrypted volumes, and tagged test keys/security groups.

The role can allocate and release hosts; launch, stop, start, reboot and terminate test instances; configure their test security groups; import and delete task SSH public keys; inspect inventory, quotas, pricing and public macOS AMI parameters; and delete tagged leftover volumes/network interfaces. It cannot modify IAM, retag unrelated resources, change existing VPCs/subnets, launch another instance family or attach an IAM instance role.

Cleanup schedules use names beginning `aimgr-macos-` in EventBridge Scheduler's default group. The only role this profile can pass is **`MacOSTestCleanup`**, and only to Scheduler. That role can terminate, release or delete resources with the testing tag. It has no account-administration permissions.

## Rental and cleanup procedure

1. Inspect existing tagged hosts/instances before allocating anything. Use a unique client token and preserve the creation receipt so a retry cannot create a second rental.
2. Import the task SSH public key. Keep its private key on the isolated GCP control VM. Permit inbound SSH only from that VM. Do not put AWS credentials, a personal browser profile or unrelated files on the rental.
3. Allocate one Mac host, launch the tagged instance with encrypted storage and deletion on termination, and immediately create its cleanup schedules using this profile.
4. Schedule termination for the agreed test deadline. Host release must start after AWS's 24-hour minimum and keep making bounded recurring attempts while the host is unavailable. `ReleaseHosts` can return an `Unsuccessful` list with HTTP success, so Scheduler delivery retries alone do not prove release. The test receipt must give the exact termination time, release interval and end time.
5. After testing, remove task credential copies, terminate the instance, and verify volume deletion. Release the host once eligible; verify its state becomes `released`. Delete the task security group, imported public key and obsolete schedules. Record any scheduled cleanup still outstanding; a submitted request is not a completed release.

AWS documents the [24-hour allocation minimum](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html), [host scrubbing and release](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/mac-instance-stop.html), and [Scheduler API targets](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-universal.html).

## Verification and related plan

On 2026-11-01, the profile successfully assumed `MacOSTestOperator` and read EC2 subnets, host offerings, the macOS AMI and Mac host quotas. AWS Access Analyzer accepted all four role/trust policies without findings. IAM simulation allowed tagged Mac allocation and tagged test termination, and denied untagged allocation, unrelated instance termination, IAM role creation and passing the cleanup role to EC2. A cold reviewer approved the authorization design. The profile also created the tagged test security group and SSH rule, imported the task public key, allocated one Mac host, launched its encrypted macOS instance, and created/read back its termination and recurring release schedules. [Access and operation receipts](evidence/claude-privacy-2026-10-31/macos-aws-access.json) are updated as the rental proceeds; these access checks do not establish macOS application correctness.

The [Claude privacy plan](CLAUDE_PRIVACY_PROXY_WORKLOG_2026-10-30.md#11-required-offsite-mac-work-and-rental-access) owns the current implementation/test requirements. Use only its two sacrificial accounts through their assigned proxies; keep the original real-account Chrome profiles on their original host. No tests on Amir's physical Macs.

The first rental completed native and real-account verification on 2026-11-01; its credential copies were removed and termination requested. The [rental receipt](evidence/claude-privacy-2026-10-31/macos-aws-access.json) records actual instance/disk state separately from the scheduled dedicated-host release and security-group cleanup. Those bounded recurring schedules self-delete after their end time. Preserve the reusable operator profile and roles for future testing.
