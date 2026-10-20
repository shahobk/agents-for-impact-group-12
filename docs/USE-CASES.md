## USE CASES

### Onboarding
- Choose if one wants to donate or open to receive

### Donation

Donor
- Open a page
- Type in plain text what you have
- [Take a picture - create description from picture]
- Use Voice instead of typing text
- Mention expiry date / deadline
- Location for pickup or willingness to drive distance (within 5 km)
- Provide feedback means (email) - for notifications
- Click "SUBMIT"

What happens next:
- Status changes dynamically on the page (i.e. matching / pending / complete / declined)
- Email sent about the submission, and linked the status page
- When something changes (somebody wants to pikup or some wants to accept drop off) - get notification when, and who (name)

### Recepients

Recipient
- Receives notification
- See the details of request [and why you're good match]
- Recipient can make decision: accept / decline, and if accept - provide details how receive / deadline

### Volunteer Drivers (optional, can be follow up)
A simple way to get notfications, can be integrated with Uber / Lyft - if some drivers would like to participate, the algorithm to match based on their routes so it's minimum hassle for them - they can pickup and drop off and claim volunteer badges, which also contributes to their rating.
Additional integration with TooGoodToGo app, etc.

### Matching Algorithm
- take into account features like:
    - if one _can pick it up_ and has needed capabilities (fridge, shelf racks, etc)
    - deadline to pickup (urgency)
    - business hours / pickup time
    - distance
    - neighboirhood in need / affordability / poverty rate (can be live data)
    - preference on pickup (with distance) / delivery   

- no duplicates / concurrency collisions
- [can fan-out top N most suitable recipients - first come/first served]


### Implementation Approach
- for notifications - simulate, we will show it internally, but in real life it's email/push notification, etc
- for components - use Google Cloud recommended ones on enterprise level / CX level, hosting highly available apps - as the labs recommended / taught

### UI in general
- Have map
- Live tracking of recipients / donators, etc.
- Some stats / zone highlights

## Other (can be follow ups)

- Splitting parts - partial-donation / pickup - can be prioritizing long-income zones

