/* Opportunistic cleanup only: absence is usable only after a complete, quiet
 * task scan. Removing a live AppArmor profile would unconfine its consumers.
 * No daemon, process termination, or foreground-exit lifetime assumption. */
#include <sys/vfs.h>
#include <linux/magic.h>

static unsigned long long codex_pid_namespace(void) {
    struct stat st;
    if (stat("/proc/self/ns/pid", &st)) return 0;
    return (unsigned long long)st.st_ino;
}
static int gc_numeric(const char *s) {
    if (!*s) return 0;
    for (; *s; ++s) if (*s<'0' || *s>'9') return 0;
    return 1;
}
static int gc_proc_complete(unsigned long long namespace) {
    struct stat st;struct statfs fs;
    if (statfs("/proc", &fs) || fs.f_type!=PROC_SUPER_MAGIC
        || stat("/proc/1/ns/pid", &st) || (unsigned long long)st.st_ino!=namespace) return 0;
    FILE *file=fopen("/proc/self/mountinfo","re");if (!file) return 0;
    char *line=NULL;size_t cap=0;int root=0,ok=1;
    while (getline(&line,&cap,file)>=0) {
        char source[PATH_MAX],target[PATH_MAX],options[4096];
        if (sscanf(line,"%*u %*u %*s %4095s %4095s %4095s",source,target,options)!=3) { ok=0;break; }
        if (!strcmp(target,"/proc")) {
            char *type=strstr(line," - proc ");
            if (root++ || strcmp(source,"/") || !type || strstr(line,"hidepid=")) { ok=0;break; }
        } else if (!strncmp(target,"/proc/",6)) {
            // Numeric task paths and the two aliases must not be masked.
            const char *child=target+6;
            if ((*child>='0' && *child<='9') || !strncmp(child,"self",4) || !strncmp(child,"thread-self",11)
                || !strcmp(child,"stat") || !strcmp(child,"loadavg")) { ok=0;break; }
        }
    }
    if (ferror(file)) ok=0;
    free(line);fclose(file);return ok && root==1;
}
static int gc_forks(unsigned long long *value) {
    FILE *file=fopen("/proc/stat","re");if (!file) return 0;
    char *line=NULL;size_t cap=0;int found=0;
    while (getline(&line,&cap,file)>=0) if (sscanf(line,"processes %llu",value)==1) { found=1;break; }
    if (ferror(file)) found=0;
    free(line);fclose(file);return found;
}
static int gc_population(unsigned long long *value) {
    FILE *file=fopen("/proc/loadavg","re");if (!file) return 0;
    int found=fscanf(file,"%*s %*s %*s %*u/%llu",value)==1;
    fclose(file);return found;
}
struct gc_pair { char name[160]; int live; };
static int gc_label(const char *file,struct gc_pair *pairs,size_t count) {
    int fd=open(file,O_RDONLY|O_CLOEXEC);if (fd<0) return 0;
    char label[65536];ssize_t n=read(fd,label,sizeof(label)-1);close(fd);
    if (n<=0 || n==(ssize_t)sizeof(label)-1 || memchr(label,0,(size_t)n)) return 0;
    label[n]=0;
    // Substring matching is deliberately conservative. It includes both pair
    // members and every stacked/namespace-qualified component without parsing
    // AppArmor's evolving printable label grammar.
    for (size_t i=0;i<count;i++) if (strstr(label,pairs[i].name)) pairs[i].live=1;
    return 1;
}
static int gc_tasks(struct gc_pair *pairs,size_t count) {
    DIR *proc=opendir("/proc");if (!proc) return 0;
    struct dirent *pid,*tid;int ok=1;
    for (;;) {
        errno=0;pid=readdir(proc);if (!pid) { if (errno) ok=0;break; }
        if (!gc_numeric(pid->d_name)) continue;
        char directory[PATH_MAX];snprintf(directory,sizeof(directory),"/proc/%s/task",pid->d_name);
        DIR *tasks=opendir(directory);if (!tasks) { ok=0;break; }
        for (;;) {
            errno=0;tid=readdir(tasks);if (!tid) { if (errno) ok=0;break; }
            if (!gc_numeric(tid->d_name)) continue;
            char file[PATH_MAX];
            if (snprintf(file,sizeof(file),"%s/%s/attr/current",directory,tid->d_name)>=(int)sizeof(file)
                || !gc_label(file,pairs,count)) { ok=0;break; }
        }
        closedir(tasks);if (!ok) break;
    }
    closedir(proc);return ok;
}
static void codex_prune_profiles(int lock,unsigned long long namespace) {
    if (!namespace || flock(lock,LOCK_EX|LOCK_NB)) return;
    struct gc_pair *pairs=NULL;size_t count=0;char *line=NULL;size_t cap=0;
    FILE *file=NULL;unsigned long long before,after,population_before,population_after;
    if (!gc_proc_complete(namespace)) goto done;
    file=fopen("/sys/kernel/security/apparmor/profiles","re");if (!file) goto done;
    char prefix[96];snprintf(prefix,sizeof(prefix),"aim-codex-p-%u-n%llu-",caller,namespace);
    size_t length=strlen(prefix);
    while (getline(&line,&cap,file)>=0) {
        if (strncmp(line,prefix,length)) continue;
        size_t n=strcspn(line," \n");line[n]=0;
        if (n!=length+32 && !(n==length+38 && !strcmp(line+length+32,"-tools"))) goto done;
        for (size_t i=length;i<length+32;i++) if (!strchr("0123456789abcdef",line[i])) goto done;
        line[length+32]=0;
        size_t i;for (i=0;i<count;i++) if (!strcmp(pairs[i].name,line)) break;
        if (i<count) continue;
        if (count>=16384) goto done; // A damaged inventory must not burden launch.
        struct gc_pair *next=realloc(pairs,(count+1)*sizeof(*pairs));if (!next) goto done;
        pairs=next;snprintf(pairs[count].name,sizeof(pairs[count].name),"%s",line);pairs[count++].live=0;
    }
    if (ferror(file)) goto done;
    fclose(file);file=NULL;
    if (!count || !gc_forks(&before) || !gc_population(&population_before)
        || !gc_tasks(pairs,count) || !gc_population(&population_after)
        || !gc_forks(&after) || before!=after || population_before!=population_after) goto done;
    // The exclusive lock stays held through removal. A compliant launcher
    // cannot expose a loaded-but-not-entered pair to the scan.
    for (size_t i=0;i<count;i++) if (!pairs[i].live) {
        for (int tools=0;tools<2;tools++) {
            char name[170];snprintf(name,sizeof(name),"%s%s",pairs[i].name,tools?"-tools":"");
            int fd=open("/sys/kernel/security/apparmor/.remove",O_WRONLY|O_CLOEXEC);
            if (fd<0) goto done;
            ssize_t n=write(fd,name,strlen(name));int error=errno;close(fd);
            if (n!=(ssize_t)strlen(name) && error!=ENOENT) goto done;
        }
    }
done:
    if (file) fclose(file);
    free(line);free(pairs);flock(lock,LOCK_UN);
}
