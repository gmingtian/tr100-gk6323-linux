#include <assert.h>
#include "gk6323-temp.h"
int main(void)
{
    assert(gk6323_temp_mc(127, 0) == -40000);
    assert(gk6323_temp_mc(911, 0) == 125000);
    assert(gk6323_temp_mc(519, 0) == 42500);
    assert(gk6323_temp_mc(519, 2u << 18) == 44500);
    assert(gk6323_temp_mc(519, (1u << 22) | (2u << 18)) == 40500);
    unsigned int samples[4] = {0x02070207, 0x02070207, 0x02070207, 0x02070207};
    assert(gk6323_samples_raw(samples) == 519);
    samples[0] = 0x00000207; /* Partially filled hardware sampling window. */
    assert(gk6323_samples_raw(samples) < 0);
    samples[0] = 0x02070207; samples[3] = 0x03ff0207;
    assert(gk6323_samples_raw(samples) < 0);
    return 0;
}
